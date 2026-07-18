// Board canvas: rendering, the overlay stack, and the cursor readout.
//
// This module is the ONLY place that converts a (row, col) into pixels. The old monitor let
// three call sites each recompute the cell size from a different magic number (800, 600, 512),
// so highlights landed at a different scale than the board they were highlighting. Everything
// here reads `view.cell`, and nothing outside this module may compute a scale.

const HOVER_STYLE = { fill: "rgba(59,130,246,0.40)", stroke: "rgba(59,130,246,0.90)", width: 2 };
const PIN_STYLE = { fill: "rgba(255,220,0,0.30)", stroke: "rgba(255,220,0,0.90)", width: 2 };
const CURSOR_STYLE = { fill: "rgba(255,255,255,0.15)", stroke: "rgba(255,255,255,0.50)", width: 1 };

export const view = { grid: null, rows: 0, cols: 0, cell: 0, width: 0, height: 0 };

// Highlights survive a repaint: the base board is redrawn beneath them, never over them.
export const overlay = {
  clicks: [], // [{row, col, current}] the MOUSE actions of the selected turn
  pinned: [], // [{row, col}] cells the reviewer clicked to keep lit
  hovered: [], // [{row, col}] cells named by the text under the cursor
  cursor: null, // {row, col} the cell under the pointer
  diff: null, // Set of (row*cols+col) cells that changed vs the reference board, or null
};

let canvas = null;
let ctx = null;
let palette = [];
let colorChars = "";
let onCursorMove = () => {};

export function initBoard(canvasEl, { onCursor } = {}) {
  canvas = canvasEl;
  ctx = canvas.getContext("2d");
  onCursorMove = onCursor || (() => {});
  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseleave", handleMouseLeave);
  canvas.addEventListener("click", handleClick);
}

export function setPalette(nextPalette, nextColorChars) {
  palette = nextPalette && nextPalette.length ? nextPalette : palette;
  colorChars = nextColorChars || colorChars;
}

/** Decode the `board_ascii` wire format into a grid of palette indices. */
export function decodeBoard(boardAscii) {
  if (!boardAscii) return null;
  const rows = boardAscii.split("\n").filter((row) => row.length);
  if (!rows.length) return null;
  return rows.map((row) => Array.from(row, (char) => Math.max(0, colorChars.indexOf(char))));
}

export function showBoard(boardAscii) {
  const grid = decodeBoard(boardAscii);
  if (!grid) return;
  const rows = grid.length;
  const cols = grid[0].length;
  const box = canvas.parentElement.getBoundingClientRect();
  const cell = Math.max(1, Math.floor(Math.min((box.width - 16) / cols, (box.height - 16) / rows)));

  Object.assign(view, { grid, rows, cols, cell, width: cols * cell, height: rows * cell });
  canvas.width = view.width;
  canvas.height = view.height;
  redraw();
}

/** The one and only (row, col) -> pixel conversion. */
export function cellRect(row, col) {
  return [col * view.cell, row * view.cell, view.cell, view.cell];
}

export function cellAt(clientX, clientY) {
  if (!view.grid) return null;
  const rect = canvas.getBoundingClientRect();
  // The canvas is styled max-width/max-height, so its backing store and its CSS box differ.
  const col = Math.floor(((clientX - rect.left) * (canvas.width / rect.width)) / view.cell);
  const row = Math.floor(((clientY - rect.top) * (canvas.height / rect.height)) / view.cell);
  if (row < 0 || row >= view.rows || col < 0 || col >= view.cols) return null;
  return { row, col };
}

export function colorAt(row, col) {
  const value = view.grid?.[row]?.[col] ?? 0;
  return { value, css: palette[value] || "#000" };
}

export function redraw() {
  if (!view.grid) return;
  paintGrid();
  if (overlay.diff) paintDiff();
  drawCells(overlay.pinned, PIN_STYLE);
  drawCells(overlay.hovered, HOVER_STYLE);
  for (const click of overlay.clicks) drawClickMarker(click);
  if (overlay.cursor) drawCells([overlay.cursor], CURSOR_STYLE);
}

/**
 * Diff mode: dim every cell that did NOT change from the reference board so the cells this
 * turn actually touched pop out. A dark wash mutes unchanged cells on any palette (white,
 * black, greys and saturated colours alike). Changed cells keep full colour; when few enough
 * to read, they also get a yellow outline. Drawn straight after the base grid so click
 * markers, pins and the cursor stay on top.
 */
function paintDiff() {
  ctx.save();
  ctx.fillStyle = "rgba(16,17,20,0.66)";
  for (let row = 0; row < view.rows; row += 1) {
    for (let col = 0; col < view.cols; col += 1) {
      if (!overlay.diff.has(row * view.cols + col)) ctx.fillRect(...cellRect(row, col));
    }
  }
  ctx.restore();
  if (overlay.diff.size && overlay.diff.size <= 256) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,214,0,0.95)";
    ctx.lineWidth = Math.max(1, Math.min(2, view.cell * 0.14));
    for (const key of overlay.diff) {
      const [x, y, w, h] = cellRect(Math.floor(key / view.cols), key % view.cols);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
    ctx.restore();
  }
}

/** Highlight the cells that differ between `referenceAscii` and the board currently shown. */
export function setDiff(referenceAscii) {
  const ref = decodeBoard(referenceAscii);
  if (!ref || !view.grid) return clearDiff();
  const changed = new Set();
  for (let row = 0; row < view.rows; row += 1) {
    for (let col = 0; col < view.cols; col += 1) {
      if ((ref[row]?.[col] ?? -1) !== view.grid[row][col]) changed.add(row * view.cols + col);
    }
  }
  overlay.diff = changed;
  redraw();
}

export function clearDiff() {
  if (overlay.diff === null) return;
  overlay.diff = null;
  redraw();
}

function paintGrid() {
  ctx.clearRect(0, 0, view.width, view.height);
  for (let row = 0; row < view.rows; row += 1) {
    for (let col = 0; col < view.cols; col += 1) {
      ctx.fillStyle = palette[view.grid[row][col]] || "#000";
      ctx.fillRect(...cellRect(row, col));
    }
  }
}

function drawCells(cells, style) {
  if (!cells.length) return;
  ctx.save();
  ctx.fillStyle = style.fill;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.width;
  for (const { row, col } of cells) {
    const [x, y, w, h] = cellRect(row, col);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  ctx.restore();
}

/**
 * Where the agent clicked. Deliberately a different SHAPE from the hover wash, not just a
 * different hue: the ARC palette contains white, black, five greys and ten saturated colours,
 * so no single fill is legible on all sixteen. A crosshair plus a dark-outer/light-inner ring
 * reads on any of them.
 */
function drawClickMarker({ row, col, current }) {
  const [x, y, cell] = cellRect(row, col);
  const cx = x + cell / 2;
  const cy = y + cell / 2;
  const radius = Math.max(3, cell * 0.62);

  ctx.save();
  ctx.globalAlpha = current === false ? 0.4 : 1;

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  crosshair(cx, cy);
  ctx.strokeStyle = "rgba(255,255,255,0.30)";
  ctx.setLineDash([3, 3]);
  crosshair(cx, cy);
  ctx.setLineDash([]);

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ring(cx, cy, radius);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  ring(cx, cy, radius);
  ctx.restore();
}

function crosshair(cx, cy) {
  ctx.beginPath();
  ctx.moveTo(cx + 0.5, 0);
  ctx.lineTo(cx + 0.5, view.height);
  ctx.moveTo(0, cy + 0.5);
  ctx.lineTo(view.width, cy + 0.5);
  ctx.stroke();
}

function ring(cx, cy, radius) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function handleMouseMove(event) {
  const cell = cellAt(event.clientX, event.clientY);
  if (!cell) return handleMouseLeave();
  if (overlay.cursor && overlay.cursor.row === cell.row && overlay.cursor.col === cell.col) {
    onCursorMove(cell, event);
    return; // Same cell: skip the repaint. Without this we redraw 4096 rects per mousemove.
  }
  overlay.cursor = cell;
  redraw();
  onCursorMove(cell, event);
}

function handleMouseLeave() {
  if (!overlay.cursor) return;
  overlay.cursor = null;
  redraw();
  onCursorMove(null);
}

function handleClick(event) {
  const cell = cellAt(event.clientX, event.clientY);
  if (cell) togglePin([cell]);
}

export function togglePin(cells) {
  for (const cell of cells) {
    const at = overlay.pinned.findIndex((p) => p.row === cell.row && p.col === cell.col);
    if (at >= 0) overlay.pinned.splice(at, 1);
    else overlay.pinned.push({ row: cell.row, col: cell.col });
  }
  redraw();
}

export function setHovered(cells) {
  overlay.hovered = cells;
  redraw();
}

export function setClicks(clicks) {
  overlay.clicks = clicks;
  redraw();
}

export function clearPins() {
  overlay.pinned = [];
  overlay.hovered = [];
  redraw();
}

/** Paint a board into an arbitrary canvas at a fixed cell size (the overview thumbnails). */
export function paintThumb(canvasEl, boardAscii, cell = 2) {
  const grid = decodeBoard(boardAscii);
  if (!grid) return;
  const rows = grid.length;
  const cols = grid[0].length;
  canvasEl.width = cols * cell;
  canvasEl.height = rows * cell;
  const thumbCtx = canvasEl.getContext("2d");
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      thumbCtx.fillStyle = palette[grid[row][col]] || "#000";
      thumbCtx.fillRect(col * cell, row * cell, cell, cell);
    }
  }
}
