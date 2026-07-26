// Games tab — in-browser game engine.
//
// Runs the actual ARC-AGI-3 `arcengine` Python game inside a Web Worker via
// Pyodide (WASM CPython + numpy), so a game session needs nothing from our
// server beyond the static .py source text (docs/static/games/src/<id>/).
// Adapted from the sibling arc-agi-3 repo's static/js/engine.js "PYODIDE GAME
// ENGINE" section — same proven recipe (arcengine's wheel is fetched
// straight from PyPI and unzipped into site-packages, bypassing micropip,
// which can't handle pydantic-core's C extension).

let _engineWorker = null;
let _engineReady = false;
let _engineLoading = false;
let _engineCallId = 0;
const _enginePending = new Map();
let _engineProgress = { stage: "", percent: 0 };
let _engineProgressCb = () => {};

export function onEngineProgress(cb) {
  _engineProgressCb = cb || (() => {});
}

function _initEngineWorker() {
  if (_engineWorker) return Promise.resolve();
  _engineLoading = true;
  const workerSrc = `
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js');
    let pyodide = null;
    let _game_instance = null;
    let _undo_stack = [];
    let _game_class_name = '';

    function postProgress(stage, percent) {
      self.postMessage({type: 'progress', stage, percent});
    }

    self.onmessage = async (e) => {
      const msg = e.data;

      if (msg.type === 'init') {
        try {
          postProgress('Loading Pyodide runtime...', 5);
          pyodide = await loadPyodide();
          postProgress('Loading packages...', 30);
          await pyodide.loadPackage(['numpy', 'pydantic']);
          postProgress('Installing arcengine...', 60);
          // Bypass micropip entirely -- it can't handle pydantic-core (C ext).
          // Fetch the wheel from PyPI directly, extract to site-packages.
          await pyodide.runPythonAsync(\`
import json, zipfile, io, importlib, site
from pyodide.http import pyfetch

resp = await pyfetch("https://pypi.org/pypi/arcengine/json")
meta = json.loads(await resp.string())
whl_url = next(u["url"] for u in meta["urls"] if u["filename"].endswith("py3-none-any.whl"))

whl_resp = await pyfetch(whl_url)
whl_bytes = bytes(await whl_resp.bytes())

sp = site.getsitepackages()[0]
with zipfile.ZipFile(io.BytesIO(whl_bytes)) as zf:
    zf.extractall(sp)
importlib.invalidate_caches()

from arcengine import ARCBaseGame  # noqa: F401 (import-error check)
          \`);

          // Drop the tile-render shim in as a real importable module and patch
          // Camera.render once. Mode stays "solid" (= stock engine output)
          // until the UI asks for otherwise.
          postProgress('Installing tile renderer...', 90);
          pyodide.globals.set('_tiles_source', msg.tiles_source);
          pyodide.runPython(\`
import site, importlib
with open(site.getsitepackages()[0] + "/arc_tiles.py", "w") as _f:
    _f.write(_tiles_source)
importlib.invalidate_caches()
import arc_tiles
arc_tiles.install()

def _tile_scale():
    cam = _game_instance.camera
    return min(64 // max(1, cam.width), 64 // max(1, cam.height))
          \`);

          // Frame filters (docs/static/games/src/_shared/frame_filters.py) are a
          // second, independent view-layer transform stacked on top of whatever
          // the tile renderer produced: recolor/noise/merge/occlude the emitted
          // grid. Same fetch-once-exec-into-globals recipe as arc_tiles above.
          postProgress('Installing frame filters...', 96);
          pyodide.globals.set('_filters_source', msg.filters_source);
          pyodide.runPython(\`
exec(_filters_source)
_filter_id = 'none'
_filter_params = {}
_filter_base_seed = 0
_filter_counter = 0
_last_raw_grid = None

def _apply_filter(grid):
    global _filter_counter, _last_raw_grid
    _last_raw_grid = grid
    if _filter_id == 'none' or _filter_id not in FILTERS:
        return grid
    _filter_counter += 1
    _seed = _filter_base_seed * 1000003 + _filter_counter
    return apply_filter(grid, _filter_id, _filter_params, seed=_seed)
          \`);
          postProgress('Ready', 100);
          self.postMessage({type: 'ready', id: msg.id});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }

      if (msg.type === 'load_game') {
        try {
          const {source, class_name, id} = msg;
          _game_class_name = class_name;
          _undo_stack = [];

          pyodide.runPython(\`
import numpy as np
import arcengine
from arcengine import *
import copy
\`);
          pyodide.globals.set('_source_code', source);
          pyodide.globals.set('_class_name', class_name);
          pyodide.runPython(\`
__file__ = '/virtual/game.py'
exec(_source_code)
_game_instance = eval(_class_name + "()")
_undo_stack = []
_reset_action = ActionInput(id=GameAction.RESET)
_frame_data = _game_instance.perform_action(_reset_action, raw=True)
\`);

          const stateJson = pyodide.runPython(\`
import json
_frame = _apply_filter(_frame_data.frame[-1].tolist()) if _frame_data.frame else []
_avail = list(_frame_data.available_actions)
json.dumps({
    "grid": _frame,
    "state": _frame_data.state.value if hasattr(_frame_data.state, "value") else str(_frame_data.state),
    "levels_completed": _frame_data.levels_completed,
    "win_levels": _frame_data.win_levels,
    "available_actions": _avail,
    "tile_scale": _tile_scale(),
})
\`);
          self.postMessage({type: 'game_loaded', id, state: JSON.parse(stateJson)});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }

      if (msg.type === 'step') {
        try {
          const {action, data, id} = msg;
          pyodide.runPython('_undo_stack.append((copy.deepcopy(_game_instance), copy.deepcopy(_frame_data)))');

          pyodide.globals.set('_action_id', action);
          pyodide.globals.set('_action_data', data ? pyodide.toPy(data) : pyodide.globals.get('None'));
          pyodide.runPython(\`
_action = GameAction.from_id(int(_action_id))
_data = dict(_action_data) if _action_data is not None and _action_data != 'None' else None
_action_input = ActionInput(id=_action, data=_data or {})
_frame_data = _game_instance.perform_action(_action_input, raw=True)
\`);

          const stateJson = pyodide.runPython(\`
import json
_all_frames = [f.tolist() for f in _frame_data.frame] if _frame_data.frame else []
_step = max(1, len(_all_frames) // 120)
_frames_out = _all_frames[::_step]
if _all_frames and _frames_out[-1] is not _all_frames[-1]:
    _frames_out.append(_all_frames[-1])
_frames_out = [_apply_filter(f) for f in _frames_out]
_frame = _frames_out[-1] if _frames_out else []
_avail = list(_frame_data.available_actions)
json.dumps({
    "grid": _frame,
    "frames": _frames_out,
    "state": _frame_data.state.value if hasattr(_frame_data.state, "value") else str(_frame_data.state),
    "levels_completed": _frame_data.levels_completed,
    "win_levels": _frame_data.win_levels,
    "available_actions": _avail,
    "tile_scale": _tile_scale(),
    "undo_depth": len(_undo_stack),
})
\`);
          self.postMessage({type: 'step_result', id, state: JSON.parse(stateJson)});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }

      if (msg.type === 'reset') {
        try {
          pyodide.runPython(\`
_reset_action = ActionInput(id=GameAction.RESET)
_frame_data = _game_instance.perform_action(_reset_action, raw=True)
_undo_stack = []
\`);
          const stateJson = pyodide.runPython(\`
import json
_frame = _apply_filter(_frame_data.frame[-1].tolist()) if _frame_data.frame else []
_avail = list(_frame_data.available_actions)
json.dumps({
    "grid": _frame,
    "state": _frame_data.state.value if hasattr(_frame_data.state, "value") else str(_frame_data.state),
    "levels_completed": _frame_data.levels_completed,
    "win_levels": _frame_data.win_levels,
    "available_actions": _avail,
    "tile_scale": _tile_scale(),
    "undo_depth": 0,
})
\`);
          self.postMessage({type: 'reset_result', id: msg.id, state: JSON.parse(stateJson)});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }

      if (msg.type === 'set_tile_mode') {
        try {
          const {mode, seed, id} = msg;
          pyodide.globals.set('_tile_mode', mode);
          pyodide.globals.set('_tile_seed', seed);
          // Re-render the live board rather than replaying the action: the
          // stored frames were rasterised under the previous skin.
          pyodide.runPython(\`
arc_tiles.set_mode(_tile_mode, int(_tile_seed))
_frame = _game_instance.camera.render(_game_instance.current_level.get_sprites())
\`);
          const stateJson = pyodide.runPython(\`
import json
_avail = list(_frame_data.available_actions)
json.dumps({
    "grid": _apply_filter(_frame.tolist()),
    "state": _frame_data.state.value if hasattr(_frame_data.state, "value") else str(_frame_data.state),
    "levels_completed": _frame_data.levels_completed,
    "win_levels": _frame_data.win_levels,
    "available_actions": _avail,
    "tile_scale": _tile_scale(),
    "undo_depth": len(_undo_stack),
})
\`);
          self.postMessage({type: 'set_tile_mode_result', id, state: JSON.parse(stateJson)});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }

      if (msg.type === 'undo') {
        try {
          const {count, id} = msg;
          pyodide.globals.set('_undo_count', count);
          pyodide.runPython(\`
if len(_undo_stack) >= _undo_count:
    for _ in range(_undo_count - 1):
        _undo_stack.pop()
    _game_instance, _frame_data = _undo_stack.pop()
elif _undo_stack:
    _game_instance, _frame_data = _undo_stack[0]
    _undo_stack = []
\`);
          const stateJson = pyodide.runPython(\`
import json
# Re-render instead of reusing _frame_data.frame: if the skin changed since
# this state was pushed, the stored raster is stale.
_frame = _apply_filter(_game_instance.camera.render(_game_instance.current_level.get_sprites()).tolist())
_avail = list(_frame_data.available_actions)
json.dumps({
    "grid": _frame,
    "state": _frame_data.state.value if hasattr(_frame_data.state, "value") else str(_frame_data.state),
    "levels_completed": _frame_data.levels_completed,
    "win_levels": _frame_data.win_levels,
    "available_actions": _avail,
    "tile_scale": _tile_scale(),
    "undo_depth": len(_undo_stack),
})
\`);
          self.postMessage({type: 'undo_result', id, state: JSON.parse(stateJson)});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }

      if (msg.type === 'jump_level') {
        try {
          const {level, id} = msg;
          pyodide.globals.set('_target_level', level);
          pyodide.runPython(\`
from arcengine import GameState
_game_instance._levels[_target_level] = _game_instance._clean_levels[_target_level].clone()
_game_instance.set_level(_target_level)
_game_instance._score = _target_level
_game_instance._state = GameState.NOT_FINISHED
_frame = _game_instance.camera.render(_game_instance.current_level.get_sprites())
_undo_stack = []
\`);
          const stateJson = pyodide.runPython(\`
import json
_avail = list(_game_instance._available_actions)
json.dumps({
    "grid": _apply_filter(_frame.tolist()),
    "state": _game_instance._state.value if hasattr(_game_instance._state, "value") else str(_game_instance._state),
    "levels_completed": _game_instance._score,
    "win_levels": _game_instance._win_score,
    "available_actions": _avail,
    "tile_scale": _tile_scale(),
    "undo_depth": 0,
})
\`);
          self.postMessage({type: 'jump_level_result', id, state: JSON.parse(stateJson)});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }

      if (msg.type === 'set_filter') {
        try {
          const {filter_id, params, base_seed, id} = msg;
          pyodide.globals.set('_filter_id', filter_id);
          pyodide.globals.set('_filter_params', pyodide.toPy(params || {}));
          pyodide.globals.set('_filter_base_seed', base_seed || 0);
          // Re-render the CURRENT frame through the new filter -- no game action
          // taken, no _undo_stack push. _last_raw_grid is set as a side effect of
          // every prior _apply_filter call (see the init handler above), so it
          // always holds whatever the last grid_emit site produced.
          const stateJson = pyodide.runPython(\`
import json
_filter_params = dict(_filter_params)
_frame = _apply_filter(_last_raw_grid) if _last_raw_grid is not None else []
_avail = list(_frame_data.available_actions)
json.dumps({
    "grid": _frame,
    "state": _frame_data.state.value if hasattr(_frame_data.state, "value") else str(_frame_data.state),
    "levels_completed": _frame_data.levels_completed,
    "win_levels": _frame_data.win_levels,
    "available_actions": _avail,
    "tile_scale": _tile_scale(),
    "undo_depth": len(_undo_stack),
})
\`);
          self.postMessage({type: 'filter_result', id, state: JSON.parse(stateJson)});
        } catch (err) {
          self.postMessage({type: 'error', id: msg.id, error: err.message});
        }
        return;
      }
    };
  `;
  const blob = new Blob([workerSrc], { type: "application/javascript" });
  _engineWorker = new Worker(URL.createObjectURL(blob));
  _engineWorker.onmessage = (e) => {
    const { type, id, state, error, stage, percent } = e.data;
    if (type === "progress") {
      _engineProgress = { stage, percent };
      _engineProgressCb(_engineProgress);
    } else if (type === "ready") {
      _engineReady = true;
      _engineLoading = false;
      const cb = _enginePending.get(id);
      if (cb) { cb.resolve(); _enginePending.delete(id); }
    } else if (type === "error") {
      const cb = _enginePending.get(id);
      if (cb) { cb.reject(new Error(error)); _enginePending.delete(id); }
    } else if (["game_loaded", "step_result", "reset_result", "undo_result", "jump_level_result",
                "set_tile_mode_result", "filter_result"].includes(type)) {
      const cb = _enginePending.get(id);
      if (cb) { cb.resolve(state); _enginePending.delete(id); }
    }
  };
  const initId = ++_engineCallId;
  // Fetched here rather than inside the worker: the worker runs off a blob URL,
  // so it has no useful base URL to resolve a same-origin path against.
  return Promise.all([
    fetch("./static/games/arc_tiles.py").then((r) => r.text()),
    fetch("./static/games/src/_shared/frame_filters.py").then((r) => r.text()),
  ]).then(([tilesSource, filtersSource]) => new Promise((resolve, reject) => {
    _enginePending.set(initId, { resolve, reject });
    _engineWorker.postMessage({ type: "init", id: initId, tiles_source: tilesSource, filters_source: filtersSource });
  }));
}

function _send(msg) {
  const id = ++_engineCallId;
  msg.id = id;
  return new Promise((resolve, reject) => {
    _enginePending.set(id, { resolve, reject });
    _engineWorker.postMessage(msg);
    setTimeout(() => {
      if (_enginePending.has(id)) {
        _enginePending.delete(id);
        reject(new Error("[GameEngine] Timeout"));
      }
    }, 30000);
  });
}

export async function ensureGameEngine() {
  if (_engineReady) return;
  if (_engineLoading) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (_engineReady) { clearInterval(check); resolve(); }
      }, 200);
    });
  }
  return _initEngineWorker();
}

export const gameEngineReady = () => _engineReady;

export const gameLoad = (source, className) =>
  _send({ type: "load_game", source, class_name: className });
export const gameStep = (action, data) => _send({ type: "step", action, data });
export const gameReset = () => _send({ type: "reset" });
export const gameUndo = (count) => _send({ type: "undo", count });
export const gameJumpLevel = (level) => _send({ type: "jump_level", level });
// mode: "solid" (stock engine output) | "tiles" (fixed motifs) | "random"
// (motifs + palette reshuffled from `seed`). See docs/static/games/arc_tiles.py.
export const gameSetTileMode = (mode, seed) => _send({ type: "set_tile_mode", mode, seed });
// filterId: a key from frame_filters.py's FILTERS dict ("none", "palette_shuffle",
// "pixel_noise", "color_merge", "palette_cap", "block_pool", "fog_mask"). Re-renders
// the current frame immediately (no game action taken) and persists for future
// steps/resets. See docs/static/games/src/_shared/frame_filters.py.
export const gameSetFilter = (filterId, params, baseSeed) =>
  _send({ type: "set_filter", filter_id: filterId, params, base_seed: baseSeed });
