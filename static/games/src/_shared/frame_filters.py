"""Deterministic grid-transform filters for ARC-3 frames.

A single canonical module used by two consumers:
  - The Games-tab Pyodide worker (docs/static/js/games-engine.js), which fetches this
    file's TEXT as a static asset and exec()s it, same as it does for each game's own
    .py source.
  - ARC3-Inference/distill/extract_sft.py, which imports this file as a normal module
    (via a sys.path shim) when regenerating training images from cached trajectories.

Pure stdlib only (no numpy) so the exact same source runs unmodified in native CPython
and inside Pyodide, on plain nested lists.

A "grid" is a list[list[int]] of ARC-3 palette indices (0-15). Every filter takes a
grid plus a seed and returns a new grid of the same shape. Filters must use a LOCAL
random.Random(seed) instance, never the global random module -- the Pyodide worker
keeps this module's globals alive for an entire play session, so global random state
would leak noise patterns across unrelated frames/games.
"""

import random

PALETTE_SIZE = 16


def _dims(grid):
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    return rows, cols


def identity(grid, *, seed=0, **_params):
    return [row[:] for row in grid]


def palette_shuffle(grid, *, seed, **_params):
    """Permute all 16 color indices with a random bijection."""
    rng = random.Random(seed)
    perm = list(range(PALETTE_SIZE))
    rng.shuffle(perm)
    return [[perm[v] for v in row] for row in grid]


def pixel_noise(grid, *, seed, rate=0.05, **_params):
    """Replace each cell with a random color, independently, with probability `rate`."""
    rng = random.Random(seed)
    out = []
    for row in grid:
        new_row = []
        for v in row:
            new_row.append(rng.randrange(PALETTE_SIZE) if rng.random() < rate else v)
        out.append(new_row)
    return out


def color_merge(grid, *, seed, n_groups=4, **_params):
    """Randomly partition the 16 colors into `n_groups` buckets and collapse each
    bucket to one of its own members. n_groups=1 collapses the whole palette; smaller
    n_groups means more information lost. This is the "merge two colors into one" idea
    generalized to an arbitrary bucket count."""
    rng = random.Random(seed)
    n_groups = max(1, min(PALETTE_SIZE, int(n_groups)))
    colors = list(range(PALETTE_SIZE))
    rng.shuffle(colors)
    remap = [0] * PALETTE_SIZE
    chunk = PALETTE_SIZE / n_groups
    for i, color in enumerate(colors):
        group_idx = min(n_groups - 1, int(i / chunk))
        group_start = int(round(group_idx * chunk))
        representative = colors[group_start]
        remap[color] = representative
    return [[remap[v] for v in row] for row in grid]


def palette_cap(grid, *, seed, max_colors=6, **_params):
    """Keep only the `max_colors` most frequent colors in this grid; remap every other
    color to the least-frequent color among those kept (NOT a hardcoded 0 -- if 0 isn't
    already in the kept set, remapping to it would introduce an extra distinct color,
    defeating the point of "cap"). Ties in frequency are broken randomly (seeded) so
    repeated identical counts don't always favor low color indices."""
    rng = random.Random(seed)
    max_colors = max(1, min(PALETTE_SIZE, int(max_colors)))
    counts = [0] * PALETTE_SIZE
    for row in grid:
        for v in row:
            counts[v] += 1
    order = list(range(PALETTE_SIZE))
    rng.shuffle(order)
    order.sort(key=lambda c: counts[c], reverse=True)
    kept = order[:max_colors]
    kept_set = set(kept)
    fallback = kept[-1]
    return [[v if v in kept_set else fallback for v in row] for row in grid]


def block_pool(grid, *, seed=None, factor=2, **_params):
    """Downsample in factor x factor blocks by majority vote, then upsample back to
    the original size -- a pixelation/blur that destroys fine detail while keeping the
    grid's overall shape and size unchanged. No randomness: ties break on first-seen
    color within the block, so this is deterministic regardless of seed."""
    factor = max(1, int(factor))
    rows, cols = _dims(grid)
    if factor == 1 or rows == 0 or cols == 0:
        return [row[:] for row in grid]
    out = [[0] * cols for _ in range(rows)]
    for br in range(0, rows, factor):
        for bc in range(0, cols, factor):
            block_vals = []
            for r in range(br, min(br + factor, rows)):
                for c in range(bc, min(bc + factor, cols)):
                    block_vals.append(grid[r][c])
            counts = {}
            for v in block_vals:
                counts[v] = counts.get(v, 0) + 1
            winner = max(counts.items(), key=lambda kv: (kv[1], -block_vals.index(kv[0])))[0]
            for r in range(br, min(br + factor, rows)):
                for c in range(bc, min(bc + factor, cols)):
                    out[r][c] = winner
    return out


def fog_mask(grid, *, seed, coverage=0.3, fill=0, **_params):
    """Occlude a random fraction of cells (independently, not a contiguous patch) with
    a fixed `fill` color, simulating partial observability."""
    rng = random.Random(seed)
    coverage = max(0.0, min(1.0, float(coverage)))
    fill = int(fill) % PALETTE_SIZE
    return [[fill if rng.random() < coverage else v for v in row] for row in grid]


FILTERS = {
    "none": {"label": "No filter", "fn": identity, "params": []},
    "palette_shuffle": {"label": "Palette shuffle", "fn": palette_shuffle, "params": []},
    "pixel_noise": {
        "label": "Pixel noise",
        "fn": pixel_noise,
        "params": [{"name": "rate", "type": "float", "min": 0.0, "max": 0.5, "default": 0.05}],
    },
    "color_merge": {
        "label": "Color merge",
        "fn": color_merge,
        "params": [{"name": "n_groups", "type": "int", "min": 2, "max": 8, "default": 4}],
    },
    "palette_cap": {
        "label": "Palette cap",
        "fn": palette_cap,
        "params": [{"name": "max_colors", "type": "int", "min": 2, "max": 12, "default": 6}],
    },
    "block_pool": {
        "label": "Block pool",
        "fn": block_pool,
        "params": [{"name": "factor", "type": "int", "min": 2, "max": 8, "default": 2}],
    },
    "fog_mask": {
        "label": "Fog",
        "fn": fog_mask,
        "params": [{"name": "coverage", "type": "float", "min": 0.0, "max": 0.9, "default": 0.3}],
    },
}


def apply_filter(grid, filter_id, params=None, *, seed=0):
    """Single entry point: look up filter_id in FILTERS and apply it. Unknown
    filter_id (including None/"none") returns the grid unchanged."""
    entry = FILTERS.get(filter_id)
    if entry is None:
        return grid
    return entry["fn"](grid, seed=seed, **dict(params or {}))


def registry_metadata():
    """JSON-safe view of FILTERS (drops the function objects) for shipping to a UI."""
    return {fid: {"label": e["label"], "params": e["params"]} for fid, e in FILTERS.items()}
