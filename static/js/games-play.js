// Games tab — catalog browsing + human play orchestration.
// Condensed, DB/session/social-free adaptation of the sibling arc-agi-3
// repo's human.js/human-game.js/human-input.js/human-render.js: pick a game,
// play it now, no login, no recording, no leaderboard.

import { ensureGameEngine, gameEngineReady, onEngineProgress, gameLoad, gameStep, gameReset, gameUndo, gameJumpLevel, gameSetTileMode, gameSetFilter } from "./games-engine.js";

// Canonical ARC-3 board palette (values 0-15) -- identical to constants.py's
// COLOR_MAP in the reference impl and to scripts/build_games_manifest.py's
// thumbnail generator, so in-browser play matches the static thumbnails.
const COLORS = [
  "#FFFFFF", "#CCCCCC", "#999999", "#666666", "#333333", "#000000", "#E53AA3", "#FF7BCC",
  "#F93C31", "#1E93FF", "#88D8F1", "#FFDC00", "#FF851B", "#921231", "#4FCC30", "#A356D6",
];
const ACTION_NAMES = { 0: "RESET", 1: "UP", 2: "DOWN", 3: "LEFT", 4: "RIGHT", 5: "ACTION5", 6: "CLICK", 7: "ACTION7" };
const KEY_MAP = { w: 1, ArrowUp: 1, s: 2, ArrowDown: 2, a: 3, ArrowLeft: 3, d: 4, ArrowRight: 4, r: 0, z: 5, x: 7, c: 7 };

// The catalog runs to ~300 games, so every section is paged and the whole
// thing is filterable; the sidebar shows one page of the current game's
// category at a time.
const PAGE_SIZE = 30;
const CATEGORIES = [
  { key: "official", label: "Official", grid: "browseOfficial", pager: "pagerOfficial", count: "countOfficial" },
  { key: "custom", label: "Custom", grid: "browseCustom", pager: "pagerCustom", count: "countCustom" },
  { key: "redbluepill", label: "Red Blue Pill", grid: "browseRedblue", pager: "pagerRedblue", count: "countRedblue" },
];

let games = [];
let currentGame = null;     // manifest entry
let currentSource = null;   // cached .py text, so re-selecting a game skips the fetch
let state = {};             // {grid, state, levels_completed, win_levels, available_actions, tile_scale}
let stepCount = 0;
let query = "";
const pageOf = { official: 0, custom: 0, redbluepill: 0 };
let sidebarPage = 0;
let tileMode = "solid";     // "solid" | "tiles" | "random" -- see games/arc_tiles.py
let tileSeed = 1;

// Mirrors frame_filters.py's FILTERS dict (docs/static/games/src/_shared/) -- labels
// and param ranges are duplicated here the same way COLORS/PALETTE already are in
// three other places in this codebase, so this isn't a new kind of drift risk.
const FILTERS = [
  { id: "none", label: "No filter" },
  { id: "palette_shuffle", label: "Palette shuffle", seeded: true },
  { id: "pixel_noise", label: "Pixel noise", seeded: true, param: "rate", min: 0, max: 0.5, step: 0.01, default: 0.05 },
  { id: "color_merge", label: "Color merge", seeded: true, param: "n_groups", min: 2, max: 8, step: 1, default: 4 },
  { id: "palette_cap", label: "Palette cap", seeded: true, param: "max_colors", min: 2, max: 12, step: 1, default: 6 },
  { id: "block_pool", label: "Block pool", seeded: false, param: "factor", min: 2, max: 8, step: 1, default: 2 },
  { id: "fog_mask", label: "Fog", seeded: true, param: "coverage", min: 0, max: 0.9, step: 0.05, default: 0.3 },
];
let filterId = "none";
let filterParams = {};
let filterSeed = 1;
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
  renderBrowse();

  $("backToBrowse").addEventListener("click", showBrowse);
  $("resetBtn").addEventListener("click", () => runAction(() => gameReset(), "(reset)"));
  $("undoBtn").addEventListener("click", doUndo);
  $("liveToggleBtn").addEventListener("click", toggleLive);
  $("liveFpsInput").addEventListener("input", (e) => { liveFps = +e.target.value; restartLiveTick(); });
  $("gameSearch").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    for (const c of CATEGORIES) pageOf[c.key] = 0;
    renderBrowse();
  });
  setupTileBar();
  setupFilterBar();
  setupCanvasInput();
  setupKeyboard();

  const hashGame = (location.hash.match(/g=([^&]+)/) || [])[1];
  if (hashGame) selectGame(decodeURIComponent(hashGame));
}

// ── Catalog ──────────────────────────────────────────────────────────────

// `category` is the field to use; `official` is the pre-Red-Blue-Pill boolean,
// kept so an older cached manifest still lands games in a sensible section.
const categoryOf = (g) => g.category || (g.official ? "official" : "custom");

function matchesQuery(g) {
  if (!query) return true;
  const hay = `${g.title} ${g.id} ${(g.tags || []).join(" ")}`.toLowerCase();
  return hay.includes(query);
}

function renderCards(container, list, onClick, compact) {
  if (!container) return;
  container.innerHTML = "";
  container.classList.toggle("empty", list.length === 0);
  for (const g of list) {
    const card = document.createElement("div");
    card.className = compact ? "game-card compact" : "game-card";
    card.dataset.gameId = g.id;
    card.title = g.description ? `${g.title} — ${g.description}` : g.title;
    card.innerHTML = `
      <img src="./static/img/games/${g.id}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="gc-title">${g.title}</div>${compact ? "" : `<div class="gc-id">${g.id}</div>`}`;
    card.addEventListener("click", () => onClick(g.id));
    container.appendChild(card);
  }
}

function renderPager(el, total, current, onGo) {
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  el.hidden = pages <= 1;
  if (pages <= 1) return;
  const from = current * PAGE_SIZE + 1;
  const to = Math.min(total, (current + 1) * PAGE_SIZE);
  el.innerHTML = "";
  const prev = document.createElement("button");
  prev.textContent = "‹ Prev";
  prev.disabled = current === 0;
  prev.addEventListener("click", () => onGo(current - 1));
  const next = document.createElement("button");
  next.textContent = "Next ›";
  next.disabled = current >= pages - 1;
  next.addEventListener("click", () => onGo(current + 1));
  const label = document.createElement("span");
  label.textContent = `${from}–${to} of ${total}  ·  page ${current + 1}/${pages}`;
  el.append(prev, next, label);
}

function renderBrowse() {
  for (const c of CATEGORIES) {
    const list = games.filter((g) => categoryOf(g) === c.key && matchesQuery(g));
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (pageOf[c.key] >= pages) pageOf[c.key] = pages - 1;
    const p = pageOf[c.key];
    renderCards($(c.grid), list.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), selectGame);
    renderPager($(c.pager), list.length, p, (n) => { pageOf[c.key] = n; renderBrowse(); });
    const el = $(c.count);
    if (el) el.textContent = query ? `${list.length} of ${games.filter((g) => categoryOf(g) === c.key).length}` : `${list.length}`;
  }
  if (currentGame) highlightActive(currentGame.id);
}

function renderSidebar() {
  if (!currentGame) return;
  const cat = CATEGORIES.find((c) => c.key === categoryOf(currentGame)) || CATEGORIES[0];
  const list = games.filter((g) => categoryOf(g) === cat.key);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  sidebarPage = Math.max(0, Math.min(sidebarPage, pages - 1));
  $("sidebarHeading").textContent = cat.label;
  renderCards($("sidebarGrid"), list.slice(sidebarPage * PAGE_SIZE, (sidebarPage + 1) * PAGE_SIZE), selectGame, true);
  renderPager($("sidebarPager"), list.length, sidebarPage, (n) => { sidebarPage = n; renderSidebar(); });
  highlightActive(currentGame.id);
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
  // Open the sidebar on the page this game actually sits on.
  const catList = games.filter((g) => categoryOf(g) === categoryOf(entry));
  sidebarPage = Math.max(0, Math.floor(catList.findIndex((g) => g.id === entry.id) / PAGE_SIZE));
  renderSidebar();

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
  updateTileBar();
  updateFilterBar();
  buildLevelStrip();
}

// ── Tile modes ───────────────────────────────────────────────────────────
// The worker holds one global skin, so the chosen mode carries across games;
// the bar just has to resync after each load.

function setupTileBar() {
  for (const btn of document.querySelectorAll("#tileBar [data-tile-mode]")) {
    btn.addEventListener("click", () => applyTileMode(btn.dataset.tileMode));
  }
  $("reseedBtn").addEventListener("click", () => {
    tileSeed = 1 + Math.floor(Math.random() * 1e6);
    applyTileMode("random");
  });
}

async function applyTileMode(mode) {
  if (processing) return;
  tileMode = mode;
  updateTileBar();
  if (!currentGame) return;
  await runAction(() => gameSetTileMode(tileMode, tileSeed), "(skin)");
}

function updateTileBar() {
  const scale = state.tile_scale || 1;
  $("tileBar").hidden = !currentGame;
  for (const btn of document.querySelectorAll("#tileBar [data-tile-mode]")) {
    btn.classList.toggle("active", btn.dataset.tileMode === tileMode);
  }
  $("reseedBtn").hidden = tileMode !== "random";
  $("tileSeedLabel").hidden = tileMode !== "random";
  $("tileSeedLabel").textContent = `seed ${tileSeed}`;
  // A 64x64 board is already at raster resolution: there is no room inside a
  // cell to draw a motif, so only the colour reshuffle can apply.
  $("tileNote").textContent = scale >= 2
    ? `${scale}×${scale} px per cell`
    : "64×64 board — no room for tile art; Randomized recolours only";
}

// ── Frame filters ────────────────────────────────────────────────────────
// A second, independent view-layer transform (recolor/noise/merge/occlude) on
// top of whatever the tile renderer produced -- see frame_filters.py. Same
// "worker holds the global state, bar resyncs after load" pattern as tiles.

function setupFilterBar() {
  const select = $("filterSelect");
  select.innerHTML = "";
  for (const f of FILTERS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => selectFilter(select.value));
  $("filterStrength").addEventListener("input", (e) => {
    const entry = FILTERS.find((f) => f.id === filterId);
    if (!entry || !entry.param) return;
    const raw = +e.target.value;
    filterParams = { [entry.param]: entry.step < 1 ? raw : Math.round(raw) };
    applyFilter();
  });
  $("filterRerollBtn").addEventListener("click", () => {
    filterSeed = 1 + Math.floor(Math.random() * 1e6);
    applyFilter();
  });
}

function selectFilter(id) {
  filterId = id;
  const entry = FILTERS.find((f) => f.id === id);
  filterParams = entry && entry.param ? { [entry.param]: entry.default } : {};
  updateFilterBar();
  applyFilter();
}

async function applyFilter() {
  if (!currentGame) return;
  await runAction(() => gameSetFilter(filterId, filterParams, filterSeed), "(filter)");
}

function updateFilterBar() {
  $("filterBar").hidden = !currentGame;
  $("filterSelect").value = filterId;
  const entry = FILTERS.find((f) => f.id === filterId);
  const hasParam = !!(entry && entry.param);
  $("filterParamWrap").hidden = !hasParam;
  if (hasParam) {
    const input = $("filterStrength");
    input.min = entry.min;
    input.max = entry.max;
    input.step = entry.step;
    input.value = filterParams[entry.param] ?? entry.default;
    $("filterParamLabel").textContent = entry.param;
  }
  $("filterRerollBtn").hidden = !(entry && entry.seeded);
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
    else if (label !== "(undo)" && label !== "(skin)" && label !== "(filter)") stepCount++;
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
  updateTileBar();  // camera (and so tile scale) can change on a level change
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
