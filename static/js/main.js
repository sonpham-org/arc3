import { fetchGame, fetchGameFrames, fetchGameStep, fetchRunOverview, fetchRunsIndex, fetchViewerVersion } from "./api.js";

// run name -> {avg_score, actions, ...}; empty when the index is unavailable (live mode).
const runsIndex = new Map();
fetchRunsIndex().then((payload) => {
  const rows = (payload && payload.runs) || payload || [];
  rows.forEach((r) => runsIndex.set(r.run, r));
}).catch(() => {});
import { initBoard, setPalette, showBoard, setClicks, clearPins, colorAt, redraw, view, setDiff, clearDiff } from "./board.js";
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
  boardMode: document.querySelector("#board-mode"),
};

// Which board a turn's row shows:
//   consequence - the frame AFTER the turn's action(s) (the result). This is the default.
//   state       - the frame the model reasoned against (board at the START of the turn).
//   diff        - the consequence, with cells this turn changed (vs the state) highlighted.
// The row is stamped with the action's OUTCOME, so "consequence" is what you get by default;
// the other two modes disambiguate "what the model saw" from "what its action produced".
const BOARD_MODES = new Set(["state", "consequence", "diff"]);
let boardMode = (() => {
  try { const m = localStorage.getItem("arc3-board-mode"); return BOARD_MODES.has(m) ? m : "consequence"; }
  catch (_) { return "consequence"; }
})();

const log = new EventLog(el.logBody, { onSelect: (frame) => scrubber.seek(frame, { user: true }) });
const scrubber = new Scrubber(document.querySelector("#scrub"), { onSeek: selectFrame });

initBoard(el.board, { onCursor: showCursorReadout });
initCoordRefs(el.tooltip);

function syncModeButtons() {
  if (!el.boardMode) return;
  el.boardMode.querySelectorAll("button[data-mode]").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === boardMode));
}
if (el.boardMode) {
  el.boardMode.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-mode]");
    if (!btn || !BOARD_MODES.has(btn.dataset.mode)) return;
    boardMode = btn.dataset.mode;
    try { localStorage.setItem("arc3-board-mode", boardMode); } catch (_) {}
    syncModeButtons();
    const frame = state.frames[scrubber.pos];
    if (frame) selectFrame(scrubber.pos);
  });
  syncModeButtons();
}

el.back.addEventListener("click", () => location.hash = "");
el.runSelect.addEventListener("change", () => {
  location.hash = `#run=${encodeURIComponent(el.runSelect.value)}`;
});
window.addEventListener("hashchange", route);

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const game = params.get("game");
  // numeric = game index; anything else is a game_id resolved against the overview
  return { run: params.get("run"), game: game === null ? null : (/^\d+$/.test(game) ? Number(game) : game) };
}

async function route() {
  const { run, game } = parseHash();
  state.run = run;
  if (game === null) return showOverview();
  if (typeof game === "string") {
    const payload = state.overview && state.overview.selected_run === run
      ? state.overview : await fetchRunOverview(run);
    state.overview = payload;
    state.run = payload.selected_run;
    const index = payload.games.findIndex((g) => g.game_id === game);
    return showGame(index >= 0 ? index : 0);
  }
  await showGame(game);
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

function runLabel(run) {
  const info = runsIndex.get(run);
  if (!info) return run;
  return `${run} \u00b7 ${info.actions} acts \u00b7 ${info.avg_score.toFixed(3)}`;
}

function renderRunSelect(payload) {
  const runs = payload.available_runs || [];
  el.runSelect.innerHTML = runs.map((run) => `<option value="${run}">${runLabel(run)}</option>`).join("");
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
  }
  // Always (re)apply the palette from the overview we hold. Deep-linking with a game_id string
  // resolves the overview inside route() without ever setting the palette, so keying this off a
  // fresh fetch here would leave the board painting every cell "#000" (all black).
  setPalette(state.overview.arc_palette, state.overview.color_chars);
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

// The board the model reasoned against for this frame's turn: the frame just BEFORE the turn's
// first action. Every action in a multi-click turn shares one reasoning board (the model saw
// the board once, then emitted the whole batch), so all of a turn's rows resolve to the same
// state image -- while the click marker still shows which click within the batch you're on.
function stateBoardFor(frame) {
  const turn = frame.analysis_step;
  let j = frame.frameIndex;
  // Walk back over the other actions of this same turn so every row of a multi-click turn
  // resolves to the ONE board the model reasoned against. Runs without analysis_step fall
  // through to the immediately-preceding frame, which is still the pre-action board.
  if (turn !== undefined && turn !== null) {
    while (j > 0 && state.frames[j - 1] && state.frames[j - 1].analysis_step === turn) j -= 1;
  }
  const ref = j > 0 ? state.frames[j - 1] : null;
  return ref ? ref.board_ascii : frame.board_ascii;
}

function renderBoardForFrame(frame) {
  if (boardMode === "state") {
    clearDiff();
    showBoard(stateBoardFor(frame));
  } else if (boardMode === "diff") {
    showBoard(frame.board_ascii);
    setDiff(stateBoardFor(frame));
  } else {
    clearDiff();
    showBoard(frame.board_ascii);
  }
}

async function selectFrame(index) {
  const frame = state.frames[index];
  if (!frame) return;

  renderBoardForFrame(frame);
  log.select(index);

  // Every MOUSE action of this turn is marked; the one you are looking at is opaque, the
  // rest of the batch translucent -- so a multi-click turn reads as "here, here, then here".
  const turn = frame.analysis_step;
  const clicks = state.frames
    .filter((f) => f.click && turn !== undefined && f.analysis_step === turn)
    .map((f) => ({ ...f.click, current: f.frameIndex === index }));
  setClicks(clicks);

  const modeTag = boardMode === "state" ? "state (pre-action) · "
    : boardMode === "diff" ? "consequence + diff · " : "";
  el.boardMeta.textContent = `${modeTag}${frame.title || ""} · ${frame.action_display || ""} · score ${frame.score ?? 0} · ${frame.state || ""}`;

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
  if (frame) renderBoardForFrame(frame);
});

route();
setInterval(poll, POLL_MS);
