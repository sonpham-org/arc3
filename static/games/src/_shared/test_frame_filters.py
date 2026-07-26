"""Exercise frame_filters.py against small synthetic grids.

No pytest, no dependencies beyond frame_filters itself -- run directly with `python`.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import frame_filters as ff  # noqa: E402

FAIL = []


def check(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' - ' + detail) if detail else ''}")
    if not cond:
        FAIL.append(name)


def distinct_colors(grid):
    return {v for row in grid for v in row}


def same_shape(a, b):
    return len(a) == len(b) and all(len(ra) == len(rb) for ra, rb in zip(a, b))


def in_range(grid):
    return all(0 <= v < ff.PALETTE_SIZE for row in grid for v in row)


GRID = [[(r * 5 + c * 3) % ff.PALETTE_SIZE for c in range(8)] for r in range(8)]

# Perfectly uniform: every one of the 16 colors appears exactly 16 times, so any
# frequency-based tie-break (palette_cap) or partition (color_merge) is decided
# ENTIRELY by the seed -- guarantees the seed-sensitivity checks below are meaningful.
UNIFORM_GRID = [[(r + c) % ff.PALETTE_SIZE for c in range(16)] for r in range(16)]

print("=" * 72)
print("1. Shape and value-range preserved")
print("=" * 72)

for fid, entry in ff.FILTERS.items():
    params = {p["name"]: p["default"] for p in entry["params"]}
    out = ff.apply_filter(GRID, fid, params, seed=42)
    check(f"{fid}: same shape", same_shape(GRID, out))
    check(f"{fid}: values in [0, 16)", in_range(out))

print()
print("=" * 72)
print("2. Determinism per seed, variation across seeds")
print("=" * 72)

for fid in ("palette_shuffle", "pixel_noise", "color_merge", "palette_cap", "fog_mask"):
    entry = ff.FILTERS[fid]
    params = {p["name"]: p["default"] for p in entry["params"]}
    # UNIFORM_GRID forces genuine ties for the frequency-based filters (palette_cap,
    # color_merge) so seed-sensitivity is actually exercised, not a coincidence of
    # this particular grid's color distribution.
    a = ff.apply_filter(UNIFORM_GRID, fid, params, seed=7)
    b = ff.apply_filter(UNIFORM_GRID, fid, params, seed=7)
    c = ff.apply_filter(UNIFORM_GRID, fid, params, seed=99)
    check(f"{fid}: same seed -> identical output", a == b)
    check(f"{fid}: different seed -> different output", a != c)

print()
print("=" * 72)
print("3. Information-reducing filters actually reduce distinct colors")
print("=" * 72)

base_colors = len(distinct_colors(GRID))

merged = ff.apply_filter(GRID, "color_merge", {"n_groups": 3}, seed=1)
check(
    "color_merge(n_groups=3): fewer or equal distinct colors",
    len(distinct_colors(merged)) <= min(base_colors, 3),
    f"base={base_colors} after={len(distinct_colors(merged))}",
)

capped = ff.apply_filter(GRID, "palette_cap", {"max_colors": 3}, seed=1)
check(
    "palette_cap(max_colors=3): at most 3 distinct colors",
    len(distinct_colors(capped)) <= 3,
    f"after={len(distinct_colors(capped))}",
)

fogged = ff.apply_filter(GRID, "fog_mask", {"coverage": 0.9}, seed=1)
check(
    "fog_mask(coverage=0.9): heavily dominated by fill color",
    sum(row.count(0) for row in fogged) > sum(row.count(0) for row in GRID),
)

pooled = ff.apply_filter(GRID, "block_pool", {"factor": 4}, seed=1)
check(
    "block_pool(factor=4): fewer or equal distinct colors",
    len(distinct_colors(pooled)) <= base_colors,
)

print()
print("=" * 72)
print("4. identity / 'none' is a true no-op")
print("=" * 72)

check("identity returns an equal grid", ff.apply_filter(GRID, "none") == GRID)
check("unknown filter id returns grid unchanged", ff.apply_filter(GRID, "not_a_real_filter") == GRID)

print()
print("=" * 72)
print(f"RESULT: {'ALL PASSED' if not FAIL else 'FAILED: ' + ', '.join(FAIL)}")
print("=" * 72)
sys.exit(1 if FAIL else 0)
