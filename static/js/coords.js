// Coordinate references: find row/col mentions in the model's text and light them on the board.
//
// Every coordinate is matched by NAME, never by position. The old monitor logged clicks as
// `@(col,row)` and parsed them as `(row,col)`, so every click highlight was silently transposed.
// A bare `(a, b)` tuple is inherently ambiguous, so it is matched in prose only, and the tooltip
// always states the interpretation ("read as row 4, col 7") -- a wrong guess is then visible
// rather than silent.

import { setHovered, togglePin, view, colorAt } from "./board.js";

const PARTS = {
  // The action itself: MOUSE(row=39, col=45). Unambiguous.
  mouse: String.raw`(?<mouse>\bMOUSE\s*\(\s*row\s*=\s*(?<mr>\d+)\s*,\s*col\s*=\s*(?<mc>\d+)\s*\))`,
  // Keyword args in the python the model writes: click(row=39, col=45).
  kw: String.raw`(?<kw>\brow\s*=\s*(?<kr>\d+)\s*,\s*col\s*=\s*(?<kc>\d+))`,
  // Prose region: "rows 10-14, cols 3-7".
  region: String.raw`(?<region>\brows?\s+(?<rr0>\d+)(?:\s*[-–]\s*(?<rr1>\d+))?\s*,\s*cols?\s+(?<rc0>\d+)(?:\s*[-–]\s*(?<rc1>\d+))?)`,
  // Grid subscript in code: g[39][45].
  sub: String.raw`(?<sub>\[\s*(?<sr>\d+)\s*\]\s*\[\s*(?<sc>\d+)\s*\])`,
  // Bare tuple: (39, 45). Prose only -- in code every 2-tuple would match.
  tuple: String.raw`(?<tuple>\(\s*(?<tr>\d+)\s*,\s*(?<tc>\d+)\s*\))`,
  rows: String.raw`(?<rowsOnly>\brows?\s+(?<or0>\d+)(?:\s*[-–]\s*(?<or1>\d+))?)`,
  cols: String.raw`(?<colsOnly>\bcols?\s+(?<oc0>\d+)(?:\s*[-–]\s*(?<oc1>\d+))?)`,
};

// Order matters: most specific first, so "rows 3, cols 5" never degrades to a bare "rows 3".
const RE_PROSE = new RegExp(
  [PARTS.mouse, PARTS.kw, PARTS.region, PARTS.sub, PARTS.tuple, PARTS.rows, PARTS.cols].join("|"),
  "gi",
);
const RE_CODE = new RegExp(
  [PARTS.mouse, PARTS.kw, PARTS.region, PARTS.sub, PARTS.rows, PARTS.cols].join("|"),
  "gi",
);

export const MODE = { PROSE: RE_PROSE, CODE: RE_CODE };

/** Wrap every coordinate mention inside `root` in a hoverable span. */
export function annotateCoordRefs(root, regex) {
  if (!root || root.dataset.annotated === "1") return;
  root.dataset.annotated = "1";

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.textContent;
    regex.lastIndex = 0;
    if (!regex.test(text)) continue;
    regex.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const span = spanFor(match);
      if (!span) continue; // out of bounds: do not offer a hover that would highlight nothing
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      frag.appendChild(span);
      last = regex.lastIndex;
    }
    if (!last) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function spanFor(match) {
  const g = match.groups;
  const span = document.createElement("span");
  span.className = "coord-ref";
  span.textContent = match[0];

  if (g.mouse !== undefined) setPoint(span, g.mr, g.mc, "mouse");
  else if (g.kw !== undefined) setPoint(span, g.kr, g.kc, "kw");
  else if (g.region !== undefined) {
    span.dataset.rows = range(g.rr0, g.rr1);
    span.dataset.cols = range(g.rc0, g.rc1);
  } else if (g.sub !== undefined) setPoint(span, g.sr, g.sc, "sub");
  else if (g.tuple !== undefined) setPoint(span, g.tr, g.tc, "tuple");
  else if (g.rowsOnly !== undefined) span.dataset.rows = range(g.or0, g.or1);
  else if (g.colsOnly !== undefined) span.dataset.cols = range(g.oc0, g.oc1);

  return cellsFromCoordRef(span).length ? span : null;
}

function setPoint(span, row, col, kind) {
  span.dataset.row = row;
  span.dataset.col = col;
  span.dataset.kind = kind;
}

function range(from, to) {
  return to === undefined ? String(from) : `${from}-${to}`;
}

function bounds(spec, limit) {
  if (spec === undefined) return null;
  const [from, to] = String(spec).split("-");
  const start = Number(from);
  const end = to === undefined ? start : Number(to);
  return [Math.max(0, Math.min(start, end)), Math.min(limit - 1, Math.max(start, end))];
}

/** Expand a coord-ref into the cells it names, clamped to the board. */
export function cellsFromCoordRef(span) {
  if (!view.rows || !view.cols) return [];
  const cells = [];
  const { row, col, rows, cols } = span.dataset;

  if (row !== undefined && col !== undefined) {
    const r = Number(row);
    const c = Number(col);
    if (r >= 0 && r < view.rows && c >= 0 && c < view.cols) cells.push({ row: r, col: c });
    return cells;
  }

  // A bare "row 4" means the whole row; a bare "col 9" the whole column.
  const rowSpan = bounds(rows, view.rows) || [0, view.rows - 1];
  const colSpan = bounds(cols, view.cols) || [0, view.cols - 1];
  if (rows === undefined && cols === undefined) return [];
  for (let r = rowSpan[0]; r <= rowSpan[1]; r += 1) {
    for (let c = colSpan[0]; c <= colSpan[1]; c += 1) cells.push({ row: r, col: c });
  }
  return cells;
}

function describe(span, cells) {
  const { row, col, rows, cols, kind } = span.dataset;
  if (row !== undefined && col !== undefined) {
    const { value } = colorAt(Number(row), Number(col));
    const prefix = kind === "tuple" ? `(${row}, ${col}) read as ` : "";
    return { text: `${prefix}row ${row} · col ${col} = ${value}`, value };
  }
  const bits = [];
  if (rows !== undefined) bits.push(`row${String(rows).includes("-") ? "s" : ""} ${rows}`);
  if (cols !== undefined) bits.push(`col${String(cols).includes("-") ? "s" : ""} ${cols}`);
  return { text: `${bits.join(" · ")} — ${cells.length} cells`, value: null };
}

/**
 * Delegated at the document, so refs rendered later still work without rebinding.
 */
export function initCoordRefs(tooltipEl) {
  const swatch = tooltipEl.querySelector(".swatch");
  const label = tooltipEl.querySelector(".label");

  document.addEventListener("mouseover", (event) => {
    const span = event.target.closest?.(".coord-ref");
    if (!span) return;
    const cells = cellsFromCoordRef(span);
    setHovered(cells);
    const { text, value } = describe(span, cells);
    label.textContent = text;
    swatch.hidden = value === null;
    if (value !== null) swatch.style.background = colorAt(Number(span.dataset.row), Number(span.dataset.col)).css;
    showTooltip(tooltipEl, event);
  });

  document.addEventListener("mouseout", (event) => {
    if (!event.target.closest?.(".coord-ref")) return;
    setHovered([]);
    tooltipEl.hidden = true;
  });

  document.addEventListener("click", (event) => {
    const span = event.target.closest?.(".coord-ref");
    if (!span) return;
    span.classList.toggle("pinned");
    togglePin(cellsFromCoordRef(span));
  });
}

export function showTooltip(tooltipEl, event) {
  tooltipEl.hidden = false;
  const box = tooltipEl.getBoundingClientRect();
  const x = Math.min(event.clientX + 12, window.innerWidth - box.width - 8);
  const y = Math.min(event.clientY + 14, window.innerHeight - box.height - 8);
  tooltipEl.style.left = `${Math.max(8, x)}px`;
  tooltipEl.style.top = `${Math.max(8, y)}px`;
}
