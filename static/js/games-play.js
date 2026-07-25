// Games tab — catalog browsing + human play orchestration.
// Condensed, DB/session/social-free adaptation of the sibling arc-agi-3
// repo's human.js/human-game.js/human-input.js/human-render.js: pick a game,
// play it now, no login, no recording, no leaderboard.

import { ensureGameEngine, gameEngineReady, onEngineProgress, gameLoad, gameStep, gameReset, gameUndo, gameJumpLevel } from "./games-engine.js";

// Canonical ARC-3 board palette (values 0-15) -- identical to constants.py's
// COLOR_MAP in the reference impl and to scripts/build_games_manifest.py's
// thumbnail generator, so in-browser play matches the static thumbnails.
const COLORS = [
  "#FFFFFF", "#CCCCCC", "#999999", "#666666", "#333333", "#000000", "#E53AA3", "#FF7BCC",
  "#F93C31", "#1E93FF", "#88D8F1", "#FFDC00", "#FF851B", "#921231", "#4FCC30", "#A356D6",
];
const ACTION_NAMES = { 0: "RESET", 1: "UP", 2: "DOWN", 3: "LEFT", 4: "RIGHT", 5: "ACTION5", 6: "CLICK", 7: "ACTION7" };
const KEY_MAP = { w: 1, ArrowUp: 1, s: 2, ArrowDown: 2, a: 3, ArrowLeft: 3, d: 4, ArrowRight: 4, r: 0, z: 5, x: 7, c: 7 };

let games = [];
let currentGame = null;     // manifest entry
let currentSource = null;   // cached .py text, so re-selecting a game skips the fetch
let state = {};             // {grid, state, levels_completed, win_levels, available_actions}
let stepCount = 0;
let processing = false;
let liveMode = false;
let liveInterval = null;
let liveFps = 10;
let liveHeldAction = 6;
let liveIdleAction = 6;
let liveMouseX = null;
let liveMouseY = null;

const $ = (id) => document.getElementById(id);
const canvas = () => $("gameCanvas");

// ── Boot ─────────────────────────────────────────────────────────────────

async function init() {
  onEngineProgress(({ stage, percent }) => updateLoadingUI(stage, percent));
  try {
    games = await fetch("./static/games/manifest.json").then((r) => r.json());
  } catch (e) {
    $("browseOfficial").textContent = "Failed to load game catalog.";
    return;
  }
  renderGrid($("browseOfficial"), games.filter((g) => g.official), selectGame);
  renderGrid($("browseCustom"), games.filter((g) => !g.official), selectGame);
  renderGrid($("sidebarOfficial"), games.filter((g) => g.official), selectGame, true);
  renderGrid($("sidebarCustom"), games.filter((g) => !g.official), selectGame, true);

  $("backToBrowse").addEventListener("click", showBrowse);
  $("resetBtn").addEventListener("click", () => runAction(() => gameReset(), "(reset)"));
  $("undoBtn").addEventListener("click", doUndo);
  $("liveToggleBtn").addEventListener("click", toggleLive);
  $("liveFpsInput").addEventListener("input", (e) => { liveFps = +e.target.value; restartLiveTick(); });
  setupCanvasInput();
  setupKeyboard();

  const hashGame = (location.hash.match(/g=([^&]+)/) || [])[1];
  if (hashGame) selectGame(decodeURIComponent(hashGame));
}

function renderGrid(container, list, onClick, compact) {
  if (!container) return;
  container.innerHTML = "";
  for (const g of list) {
    const card = document.createElement("div");
    card.className = compact ? "game-card compact" : "game-card";
    card.dataset.gameId = g.id;
    card.innerHTML = `
      <img src="./static/img/games/${g.id}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="gc-title">${g.title}</div>${compact ? "" : `<div class="gc-id">${g.id}</div>`}`;
    card.addEventListener("click", () => onClick(g.id));
    container.appendChild(card);
  }
}

function highlightActive(id) {
  document.querySelectorAll(".game-card").forEach((c) => c.classList.toggle("active", c.dataset.gameId === id));
}

// ── View switching ───────────────────────────────────────────────────────

function showBrowse() {
  history.replaceState(null, "", location.pathname);
  $("browseView").hidden = false;
  $("playView").hidden = true;
  stopLiveIfRunning();
}

function showPlay() {
  $("browseView").hidden = true;
  $("playView").hidden = false;
}

// ── Game selection ───────────────────────────────────────────────────────

async function selectGame(id) {
  const entry = games.find((g) => g.id === id);
  if (!entry) return;
  stopLiveIfRunning();
  history.replaceState(null, "", `#g=${encodeURIComponent(id)}`);
  showPlay();
  highlightActive(id);

  currentGame = entry;
  $("gameTitle").textContent = entry.title;
  $("gameIdLabel").textContent = entry.id;
  $("gameStatus").textContent = "—";
  $("gameStatus").className = "status";
  $("endOverlay").hidden = true;
  canvas().style.display = "none";

  const engineWasReady = gameEngineReady();
  if (!engineWasReady) $("engineLoading").hidden = false;
  try {
    await ensureGameEngine();
    const source = await fetch(`./static/games/src/${entry.id}/${entry.src_file}`).then((r) => r.text());
    currentSource = source;
    state = await gameLoad(source, entry.class_name);
  } catch (err) {
    $("engineLoading").hidden = true;
    alert("Game engine failed to load: " + err.message);
    return;
  }
  $("engineLoading").hidden = true;
  canvas().style.display = "block";

  stepCount = 0;
  liveIdleAction = (state.available_actions || []).includes(7) ? 7 : 6;
  liveHeldAction = liveIdleAction;
  const isLive = (entry.tags || []).includes("live");
  $("liveToggleBtn").hidden = !isLive;
  $("liveFpsWrap").hidden = !isLive;
  liveFps = Math.min(30, Math.max(2, entry.default_fps || 10));
  $("liveFpsInput").value = liveFps;

  render(state.grid);
  updateTopBar();
  buildLevelStrip();
}

// ── Actions / stepping ───────────────────────────────────────────────────

async function runAction(fn, label) {
  if (processing) return;
  processing = true;
  canvas().style.cursor = "wait";
  try {
    const next = await fn();
    if (next.error) { alert(next.error); return; }
    if (label === "(reset)" || label === "(jump)") stepCount = 0;
    else if (label !== "(undo)") stepCount++;
    await applyState(next);
  } finally {
    processing = false;
    canvas().style.cursor = (state.available_actions || []).includes(6) ? "crosshair" : "default";
  }
}

async function applyState(next) {
  if (next.frames && next.frames.length > 1) {
    const delay = Math.max(16, Math.round(1000 / 30));
    for (let i = 0; i < next.frames.length - 1; i++) {
      render(next.frames[i]);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  delete next.frames;
  state = next;
  render(state.grid);
  updateTopBar();
  checkEnd();
}

function doAction(actionId, data) {
  if (!currentGame || state.state === "WIN" || state.state === "GAME_OVER") return;
  return runAction(() => gameStep(actionId, data || {}));
}

async function doUndo() {
  if (processing) return;
  processing = true;
  try {
    const next = await gameUndo(1);
    stepCount = Math.max(0, stepCount - 1);
    await applyState(next);
  } finally { processing = false; }
}

// ── Rendering ────────────────────────────────────────────────────────────

function render(grid) {
  if (!grid || !grid.length) return;
  const c = canvas();
  const ctx = c.getContext("2d");
  const h = grid.length, w = grid[0].length;
  const scale = Math.floor(512 / Math.max(h, w));
  c.width = w * scale;
  c.height = h * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = COLORS[grid[y][x]] || "#000";
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}

function updateTopBar() {
  const st = state.state || "NOT_FINISHED";
  const statusEl = $("gameStatus");
  statusEl.textContent = st === "NOT_FINISHED" ? "IN PROGRESS" : st.replace(/_/g, " ");
  statusEl.className = "status status-" + st.toLowerCase();
  $("levelInfo").textContent = `Level ${state.levels_completed || 0}/${state.win_levels ?? "?"}`;
  $("stepCounter").textContent = `Step ${stepCount}`;
  $("undoBtn").disabled = stepCount === 0;
  canvas().style.cursor = (state.available_actions || []).includes(6) ? "crosshair" : "default";
  $("actionHint").textContent = (state.available_actions || []).includes(6)
    ? "Click the board to act. Arrow keys / WASD also work if the game uses them."
    : "Arrow keys or WASD to act, Z/X for the extra actions.";
  document.querySelectorAll("#levelStrip .lvl").forEach((el, i) => {
    el.classList.toggle("done", i < (state.levels_completed || 0));
    el.classList.toggle("active", i === (state.levels_completed || 0));
  });
}

function buildLevelStrip() {
  const strip = $("levelStrip");
  const total = state.win_levels || 0;
  strip.innerHTML = "";
  strip.hidden = total <= 1;
  for (let i = 0; i < total; i++) {
    const el = document.createElement("button");
    el.className = "lvl" + (i === (state.levels_completed || 0) ? " active" : "");
    el.textContent = i + 1;
    el.title = `Jump to level ${i + 1}`;
    el.addEventListener("click", () => runAction(() => gameJumpLevel(i), "(jump)"));
    strip.appendChild(el);
  }
}

function checkEnd() {
  const st = state.state;
  if (st !== "WIN" && st !== "GAME_OVER") return;
  stopLiveIfRunning();
  const overlay = $("endOverlay");
  overlay.textContent = st === "WIN" ? "🎉 YOU WIN!" : "GAME OVER";
  overlay.className = "end-overlay " + (st === "WIN" ? "win" : "gameover");
  overlay.hidden = false;
}

function updateLoadingUI(stage, percent) {
  const overlay = $("engineLoading");
  if (overlay.hidden) return;
  overlay.querySelector(".loading-stage").textContent = stage || "Initializing...";
  overlay.querySelector(".bar-fill").style.width = Math.min(100, Math.max(0, percent || 0)) + "%";
}

// ── Input: keyboard + canvas click ──────────────────────────────────────

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if ($("playView").hidden) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const action = KEY_MAP[e.key];
    if (action === undefined) return;
    e.preventDefault();
    if (liveMode) liveHeldAction = action;
    else doAction(action);
  });
  document.addEventListener("keyup", (e) => {
    if (!liveMode) return;
    const action = KEY_MAP[e.key];
    if (action !== undefined && liveHeldAction === action) liveHeldAction = liveIdleAction;
  });
}

function pointerToGrid(e) {
  const c = canvas();
  const rect = c.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = Math.floor(((e.clientX - rect.left) * 64) / rect.width);
  const y = Math.floor(((e.clientY - rect.top) * 64) / rect.height);
  return { x: Math.max(0, Math.min(63, x)), y: Math.max(0, Math.min(63, y)) };
}

function setupCanvasInput() {
  const c = canvas();
  c.addEventListener("click", (e) => {
    if (liveMode || processing) return;
    if (!(state.available_actions || []).includes(6)) return;
    const p = pointerToGrid(e);
    if (p) doAction(6, p);
  });
  c.addEventListener("mousemove", (e) => {
    const p = pointerToGrid(e);
    if (p) { liveMouseX = p.x; liveMouseY = p.y; }
  });
  const release = () => { if (liveMode && liveHeldAction === 6) liveHeldAction = liveIdleAction; };
  c.addEventListener("mousedown", (e) => {
    if (!liveMode || !(state.available_actions || []).includes(6)) return;
    const p = pointerToGrid(e);
    if (p) { liveMouseX = p.x; liveMouseY = p.y; }
    liveHeldAction = 6;
  });
  c.addEventListener("mouseup", release);
  c.addEventListener("mouseleave", release);
}

// ── Live mode (continuous tick, for physics-style games) ────────────────

function toggleLive() {
  liveMode ? stopLive() : startLive();
}

function startLive() {
  liveMode = true;
  $("liveToggleBtn").textContent = "Stop live";
  $("liveToggleBtn").classList.add("active");
  restartLiveTick();
}

function stopLive() {
  liveMode = false;
  liveHeldAction = liveIdleAction;
  $("liveToggleBtn").textContent = "Live mode";
  $("liveToggleBtn").classList.remove("active");
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
}

function stopLiveIfRunning() { if (liveMode) stopLive(); }

function restartLiveTick() {
  if (liveInterval) clearInterval(liveInterval);
  if (!liveMode) return;
  liveInterval = setInterval(() => {
    if (processing || state.state === "WIN" || state.state === "GAME_OVER") return;
    const data = liveMouseX != null ? { x: liveMouseX, y: liveMouseY } : {};
    runAction(() => gameStep(liveHeldAction, data));
  }, Math.max(16, Math.round(1000 / liveFps)));
}

document.addEventListener("DOMContentLoaded", init);
