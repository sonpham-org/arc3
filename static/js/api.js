// Static-mode API: reads pre-exported JSON from ./data instead of a live server.
// Generated for the GitHub Pages log-review site; finished runs only.
const DATA = new URL("../../data/", import.meta.url);

async function json(rel) {
  const response = await fetch(new URL(rel, DATA));
  if (!response.ok) throw new Error(`${rel}: ${response.status}`);
  return response.json();
}

const r = (run) => encodeURIComponent(run);

export const fetchRunOverview = (run) =>
  run ? json(`${r(run)}/run-overview.json`) : json("default-run-overview.json");
export const fetchGame = (run, index) => json(`${r(run)}/game-${index}.json`);
export const fetchGameFrames = (run, index) => json(`${r(run)}/game-${index}-frames.json`);
export const fetchGameStep = (run, index, step) => json(`${r(run)}/game-${index}-step-${step}.json`);
// Static site: version never changes, so the hot-reload poll becomes a no-op.
export const fetchViewerVersion = async () => ({ version: "static" });
