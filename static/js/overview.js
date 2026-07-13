// The run overview: every game in the run, at once.

import { paintThumb } from "./board.js";

export function renderOverview(root, totalsEl, payload, { onOpen }) {
  const games = payload.games || [];
  renderTotals(totalsEl, games);

  root.innerHTML = "";
  if (!games.length) {
    root.innerHTML = '<div class="empty">No games in this run yet.</div>';
    return;
  }

  // A multi-pass run repeats every game_id, so the pass has to be on the card or the cards lie.
  const multiPass = new Set(games.map((g) => g.game_id)).size < games.length;

  games.forEach((game, index) => {
    const pass = multiPass && game.pass_label !== undefined ? ` <span class="pass">p${escapeHtml(game.pass_label)}</span>` : "";
    const card = document.createElement("div");
    card.className = `card is-${game.status || "unknown"}`;
    card.innerHTML = `
      <div class="card-head">
        <span class="game-id">${escapeHtml(game.game_id || "?")}${pass}</span>
        <span class="card-status status-${game.status}">${escapeHtml(game.status || "")}</span>
      </div>
      <canvas></canvas>
      <div class="levelbar"></div>
      <div class="card-meta">
        <span>L ${game.levels_completed ?? 0}/${game.total_levels ?? "?"}</span>
        <span>${game.actionCount ?? 0} actions</span>
      </div>`;

    paintThumb(card.querySelector("canvas"), game.board_ascii, 2);
    renderLevelBar(card.querySelector(".levelbar"), game);
    card.addEventListener("click", () => onOpen(index));
    root.appendChild(card);
  });
}

function renderLevelBar(bar, game) {
  const total = game.total_levels || (game.actions_per_level || []).length || 1;
  const done = game.levels_completed ?? 0;
  const perLevel = game.actions_per_level || [];
  for (let i = 0; i < total; i += 1) {
    const cell = document.createElement("i");
    if (i < done) cell.className = "done";
    else if (perLevel[i]) cell.className = "active"; // started but not cleared
    bar.appendChild(cell);
  }
}

function renderTotals(el, games) {
  const count = (status) => games.filter((g) => g.status === status).length;
  const sum = (key) => games.reduce((total, g) => total + (g[key] || 0), 0);
  const levels = games.reduce((total, g) => total + (g.levels_completed || 0), 0);
  const totalLevels = games.reduce((total, g) => total + (g.total_levels || 0), 0);

  const stats = [
    ["games", games.length],
    ["win", count("win")],
    ["playing", count("playing")],
    ["gave up", count("gave_up")],
    ["levels", `${levels}/${totalLevels}`],
    ["actions", sum("actionCount").toLocaleString()],
  ];

  el.innerHTML = stats
    .map(([label, value]) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`)
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
