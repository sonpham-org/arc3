import { fetchGame, fetchGameFrames, fetchGameStep, fetchRunOverview, fetchViewerVersion } from "./api.js";
import { initBoard, setPalette, showBoard, setClicks, clearPins, colorAt, redraw, view } from "./board.js";
import { initCoordRefs, showTooltip } from "./coords.js";
import { renderDecision } from "./decision.js";
import { EventLog } from "./log.js";
import { renderOverview } from "./overview.js";
import { Scrubber } from "./scrubber.js";

const POLL_MS = 1500;

const state = {
  run: null,
  overview: null,
  gameIndex: null,
  game: null,
  frames: [],
  stepCache: new Map(),
  viewerVersion: null,
};

const el = {
  overview: document.querySelector("#overview"),
  cards: document.querySelector("#cards"),
  totals: document.querySelector("#totals"),
  replay: document.querySelector("#replay"),
  crumb: document.querySelector("#crumb"),
  runSelect: document.querySelector("#run-select"),
  back: document.querySelector("#back"),
  board: document.querySelector("#board-canvas"),
  decision: document.querySelector("#decision-body"),
  logBody: document.querySelector("#log-body"),
  tooltip: document.querySelector("#tooltip"),
  boardMeta: document.querySelector("#board-meta"),
};

const log = new EventLog(el.logBody, { onSelect: (frame) => scrubber.seek(frame, { user: true }) });
const scrubber = new Scrubber(document.querySelector("#scrub"), { onSeek: selectFrame });

initBoard(el.board, { onCursor: showCursorReadout });
initCoordRefs(el.tooltip);

el.back.addEventListener("click", () => location.hash = "");
el.runSelect.addEventListener("change", () => {
  location.hash = `#run=${encodeURIComponent(el.runSelect.value)}`;
});
window.addEventListener("hashchange", route);

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const game = params.get("game");
  return { run: params.get("run"), game: game === null ? null : Number(game) };
}

async function route() {
  const { run, game } = parseHash();
  state.run = run;
  if (game === null) await showOverview();
  else await showGame(game);
}

async function showOverview() {
  state.gameIndex = null;
  el.overview.hidden = false;
  el.replay.hidden = true;
  el.back.hidden = true;
  await refreshOverview();
}

async function refreshOverview() {
  const payload = await fetchRunOverview(state.run);
  state.overview = payload;
  state.run = payload.selected_run;
  setPalette(payload.arc_palette, payload.color_chars);
  renderRunSelect(payload);
  el.crumb.innerHTML = `<b>${payload.run_name}</b> · ${payload.games.length} games`;
  renderOverview(el.cards, el.totals, payload, {
    onOpen: (index) => { location.hash = `#run=${encodeURIComponent(state.run)}&game=${index}`; },
  });
}

function renderRunSelect(payload) {
  const runs = payload.available_runs || [];
  if (el.runSelect.options.length !== runs.length) {
    el.runSelect.innerHTML = runs.map((run) => `<option value="${run}">${run}</option>`).join("");
  }
  el.runSelect.value = payload.selected_run;
}

async function showGame(index) {
  state.gameIndex = index;
  state.stepCache.clear();
  el.overview.hidden = true;
  el.replay.hidden = false;
  el.back.hidden = false;
  el.logBody.innerHTML = "";
  log.rows = [];
  clearPins();

  if (!state.overview) {
    const payload = await fetchRunOverview(state.run);
    state.overview = payload;
    state.run = payload.selected_run;
    setPalette(payload.arc_palette, payload.color_chars);
  }
  await refreshGame({ resetToLive: true });
}

async function refreshGame({ resetToLive = false } = {}) {
  const [game, frames] = await Promise.all([
    fetchGame(state.run, state.gameIndex),
    fetchGameFrames(state.run, state.gameIndex),
  ]);
  state.game = game;
  state.frames = frames.frames || [];

  const ended = game.status !== "playing";
  el.crumb.innerHTML = `<b>${game.game_id}</b> · <span class="status-${game.status}">${game.status}</span> · level ${game.levels_completed ?? 0}/${game.total_levels ?? "?"}`;

  log.render(state.frames, game.viewer_steps);
  if (resetToLive) scrubber.live = true;
  scrubber.setFrames(state.frames, { ended });
}

async function selectFrame(index) {
  const frame = state.frames[index];
  if (!frame) return;

  showBoard(frame.board_ascii);
  log.select(index);

  // Every MOUSE action of this turn is marked; the one you are looking at is opaque, the
  // rest of the batch translucent -- so a multi-click turn reads as "here, here, then here".
  const turn = frame.analysis_step;
  const clicks = state.frames
    .filter((f) => f.click && turn !== undefined && f.analysis_step === turn)
    .map((f) => ({ ...f.click, current: f.frameIndex === index }));
  setClicks(clicks);

  el.boardMeta.textContent = `${frame.title || ""} · ${frame.action_display || ""} · score ${frame.score ?? 0} · ${frame.state || ""}`;

  const steps = state.game.viewer_steps || [];
  const step = steps.find((s) => s.analysisStep === turn);
  if (!step) {
    renderDecision(el.decision, null);
    return;
  }
  // The previous turn is needed to diff the prompt: only the delta is worth reading.
  const previous = step.stepIndex > 0 ? await loadStep(step.stepIndex - 1) : null;
  renderDecision(el.decision, await loadStep(step.stepIndex), {
    currentClick: frame.click,
    previousStep: previous,
  });
}

async function loadStep(stepIndex) {
  if (state.stepCache.has(stepIndex)) return state.stepCache.get(stepIndex);
  const payload = await fetchGameStep(state.run, state.gameIndex, stepIndex);
  state.stepCache.set(stepIndex, payload.step);
  return payload.step;
}

function showCursorReadout(cell, event) {
  if (!cell) {
    el.tooltip.hidden = true;
    return;
  }
  const { value, css } = colorAt(cell.row, cell.col);
  el.tooltip.querySelector(".label").textContent = `row ${cell.row} · col ${cell.col} = ${value}`;
  const swatch = el.tooltip.querySelector(".swatch");
  swatch.hidden = false;
  swatch.style.background = css;
  showTooltip(el.tooltip, event);
}

// Live-tail. Files are append-only, so re-fetching is safe at any moment; the scrubber decides
// whether to follow the newest frame or hold position.
async function poll() {
  try {
    const { version } = await fetchViewerVersion();
    if (state.viewerVersion !== null && version !== state.viewerVersion) return location.reload();
    state.viewerVersion = version;

    if (state.gameIndex !== null && state.game?.status === "playing") {
      await refreshGame();
    } else if (state.gameIndex === null) {
      await refreshOverview();
    }
  } catch (error) {
    console.error("poll failed", error);
  }
}

window.addEventListener("resize", () => {
  const frame = state.frames[scrubber.pos];
  if (frame) showBoard(frame.board_ascii);
});

route();
setInterval(poll, POLL_MS);
