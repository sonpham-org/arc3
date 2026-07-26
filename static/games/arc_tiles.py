"""Tile-object rendering shim for `arcengine` games.

WHY THIS EXISTS
---------------
An arcengine game plays on a small logical board -- 8x8, 10x10, 12x12 for most
of the arc-interactive ("redbluepill") catalog -- and `Camera.render` blows that
board up to the mandated 64x64 frame with a plain nearest-neighbour
`np.repeat`. So a 8x8 game is really 64x64 pixels of 8x8 flat blocks: the frame
is full size but carries only 64 cells of information, and every cell is a
featureless square of one palette colour.

This module replaces that dumb upscale with a *tile* expansion. Each logical
cell becomes a K x K tile graphic (K = the engine's own integer scale factor,
64 // board_width), so the same board now uses the full 64x64 raster to draw
per-cell artwork: each cell reads as an object with a texture, not a blob.

Three render modes:

  "solid"   the engine's stock behaviour, pixel-identical to upstream.
  "tiles"   every palette colour gets a fixed, deterministic motif. Same game,
            same colours, but each cell is now a drawn tile. Stable across
            episodes -- an agent can learn "hatched tile == wall".
  "random"  the motif assignment AND the colour assignment are reshuffled from
            a seed, per episode. Behaviour is untouched, appearance is not:
            an agent cannot carry "blue == wall" over from a previous episode
            and has to re-derive object roles from interaction. This is the
            generalisation-test mode.

SAFETY
------
Gameplay is never affected. `ARCBaseGame.get_pixels_at_sprite` (the one place
game logic reads pixels back) calls `Camera._raw_render`, which this module
does not touch. `Camera.display_to_grid` (used by 104 of the catalog's games to
turn a click into a board cell) is also untouched, and the shim deliberately
reuses the engine's own scale/offset maths so click mapping stays exact.

HUD overlays (`RenderableUserDisplay.render_interface`) run after the upscale
in stock arcengine and still do here, so status bars stay crisp and unpermuted.

USAGE
-----
    import arc_tiles
    arc_tiles.install()                       # patch Camera.render once
    arc_tiles.set_mode("random", seed=1234)   # then play as normal

This file is served statically to the browser (the Games tab's Pyodide worker
fetches it as text and execs it) and imported directly by local tooling, so it
must stay dependency-free apart from numpy.
"""

from __future__ import annotations

import numpy as np

# Canonical ARC-3 board palette (values 0-15), duplicated from
# scripts/build_games_manifest.py / docs/static/js/games-play.js.
PALETTE = [
    (255, 255, 255), (204, 204, 204), (153, 153, 153), (102, 102, 102),
    (51, 51, 51), (0, 0, 0), (229, 58, 163), (255, 123, 204),
    (249, 60, 49), (30, 147, 255), (136, 216, 241), (255, 220, 0),
    (255, 133, 27), (146, 18, 49), (79, 204, 48), (163, 86, 214),
]
N_COLORS = 16


def _luma(idx: int) -> float:
    r, g, b = PALETTE[idx % N_COLORS]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


# White (0) or black (5), whichever contrasts more with the base colour. Keeping
# accents to these two means the base colour still dominates each tile, so the
# motif adds texture without stealing the cell's colour identity.
_ACCENT = [0 if _luma(c) < 128 else 5 for c in range(N_COLORS)]


# ── Motifs ───────────────────────────────────────────────────────────────
# Each motif is a mask builder: K -> K x K bool array, True where the accent
# colour is painted. They are written to degrade gracefully at small K (the
# 24x24 and 32x32 boards only get K=2, where most motifs collapse together --
# see MOTIF_COUNT_FOR_SCALE below).

def _m_solid(k):
    return np.zeros((k, k), bool)


def _m_checker(k):
    y, x = np.mgrid[0:k, 0:k]
    return (x + y) % 2 == 1


def _m_border(k):
    m = np.zeros((k, k), bool)
    m[0, :] = m[-1, :] = m[:, 0] = m[:, -1] = True
    return m


def _m_dot(k):
    m = np.zeros((k, k), bool)
    lo, hi = k // 3, k - k // 3
    m[lo:hi, lo:hi] = True
    return m


def _m_diag(k):
    y, x = np.mgrid[0:k, 0:k]
    return x == y


def _m_antidiag(k):
    y, x = np.mgrid[0:k, 0:k]
    return x + y == k - 1


def _m_cross(k):
    m = np.zeros((k, k), bool)
    c = k // 2
    m[c, :] = True
    m[:, c] = True
    return m


def _m_hstripe(k):
    y, _ = np.mgrid[0:k, 0:k]
    return y % 2 == 1


def _m_vstripe(k):
    _, x = np.mgrid[0:k, 0:k]
    return x % 2 == 1


def _m_corners(k):
    m = np.zeros((k, k), bool)
    s = max(1, k // 3)
    m[:s, :s] = m[:s, -s:] = m[-s:, :s] = m[-s:, -s:] = True
    return m


def _m_tophalf(k):
    m = np.zeros((k, k), bool)
    m[: k // 2, :] = True
    return m


def _m_lefthalf(k):
    m = np.zeros((k, k), bool)
    m[:, : k // 2] = True
    return m


def _m_x(k):
    return _m_diag(k) | _m_antidiag(k)


def _m_ring(k):
    return _m_border(k) | _m_dot(k)


def _m_quadrant(k):
    m = np.zeros((k, k), bool)
    m[: k // 2, : k // 2] = True
    m[k // 2 :, k // 2 :] = True
    return m


def _m_dots4(k):
    m = np.zeros((k, k), bool)
    step = max(2, k // 2)
    m[::step, ::step] = True
    return m


MOTIFS = [
    _m_solid, _m_checker, _m_border, _m_dot, _m_diag, _m_antidiag,
    _m_cross, _m_hstripe, _m_vstripe, _m_corners, _m_tophalf, _m_lefthalf,
    _m_x, _m_ring, _m_quadrant, _m_dots4,
]


def distinct_motifs(k: int) -> list[int]:
    """Indices of motifs that are actually distinguishable at scale `k`.

    At k=2 most of the shape motifs alias onto each other (a 2x2 border is a
    2x2 solid), so randomising over the full set would silently hand out
    duplicate skins. Dedupe by the mask bytes and keep the first of each.

    `_m_solid` is excluded: it is the identity, and a colour assigned to it
    would render as a flat block with no texture at all. Empty space is
    supposed to be the only flat thing on the board -- and the background gets
    that by a separate rule, not by drawing this motif.
    """
    seen, out = set(), []
    for i, fn in enumerate(MOTIFS):
        if fn is _m_solid:
            continue
        key = fn(k).tobytes()
        if key not in seen:
            seen.add(key)
            out.append(i)
    return out


# ── Skins ────────────────────────────────────────────────────────────────

class TileSkin:
    """A colour-index -> K x K tile-graphic lookup table."""

    def __init__(self, scale: int, mode: str = "tiles", seed: int = 0, background: int | None = None):
        self.scale = max(1, int(scale))
        self.mode = mode
        self.seed = seed
        # The board's empty space stays a flat colour: it is not an object, and
        # texturing the 80%-of-the-board background drowns out the tiles that
        # do carry meaning. Under "random" it still gets recoloured.
        self.background = None if background is None else int(background) % N_COLORS
        self._tiles = self._build()

    def _build(self) -> np.ndarray:
        k = self.scale
        tiles = np.zeros((N_COLORS, k, k), np.int8)

        if self.mode == "solid" or k < 2:
            # k < 2 leaves no room for a motif; a colour permutation is still
            # meaningful in "random" mode, so fall through to it below.
            for c in range(N_COLORS):
                tiles[c, :, :] = c
            if self.mode == "random":
                perm = self._colour_permutation()
                for c in range(N_COLORS):
                    tiles[c, :, :] = perm[c]
            return tiles

        usable = distinct_motifs(k)
        if self.mode == "random":
            rng = np.random.RandomState(self.seed & 0x7FFFFFFF)
            base = self._colour_permutation(rng)
            motif_of = [usable[i] for i in rng.randint(0, len(usable), N_COLORS)]
        else:
            base = list(range(N_COLORS))
            motif_of = [usable[c % len(usable)] for c in range(N_COLORS)]

        for c in range(N_COLORS):
            b = int(base[c])
            tile = np.full((k, k), b, np.int8)
            if c != self.background:
                mask = MOTIFS[motif_of[c]](k)
                tile[mask] = _ACCENT[b]
            tiles[c] = tile
        return tiles

    def _colour_permutation(self, rng=None) -> list[int]:
        rng = rng or np.random.RandomState(self.seed & 0x7FFFFFFF)
        return list(rng.permutation(N_COLORS))

    def expand(self, view: np.ndarray) -> np.ndarray:
        """Expand a H x W board of colour indices to (H*k) x (W*k) of tiles."""
        k = self.scale
        if k < 2 and self.mode != "random":
            return view
        h, w = view.shape
        # tiles[view] -> (h, w, k, k); transpose to (h, k, w, k) then flatten.
        out = self._tiles[np.clip(view, 0, N_COLORS - 1)]
        return out.transpose(0, 2, 1, 3).reshape(h * k, w * k)


# ── Camera patch ─────────────────────────────────────────────────────────

_ORIGINAL_RENDER = None
_MODE = "solid"
_SEED = 0
_SKINS: dict[tuple[int, int], TileSkin] = {}


def set_mode(mode: str = "solid", seed: int = 0) -> None:
    """Select the render mode. Modes: "solid", "tiles", "random"."""
    global _MODE, _SEED, _SKINS
    if mode not in ("solid", "tiles", "random"):
        raise ValueError(f"unknown tile mode {mode!r}")
    _MODE, _SEED, _SKINS = mode, int(seed), {}


def get_mode() -> tuple[str, int]:
    return _MODE, _SEED


def _skin_for(scale: int, background: int) -> TileSkin:
    # Keyed on background too: `set_level` resizes the camera per level, and a
    # game may change its background colour along with it.
    key = (scale, background)
    if key not in _SKINS:
        _SKINS[key] = TileSkin(scale, _MODE, _SEED, background)
    return _SKINS[key]


def _patched_render(self, sprites):
    if _MODE == "solid":
        return _ORIGINAL_RENDER(self, sprites)

    output = np.full((self.MAX_DIMENSION, self.MAX_DIMENSION), self._letter_box, dtype=np.int8)
    view = self._raw_render(sprites)
    # Same scale/offset maths the engine uses, so display_to_grid still agrees.
    scale, x_offset, y_offset = self._calculate_scale_and_offset()
    view = _skin_for(scale, self._background).expand(view)
    output[y_offset : y_offset + view.shape[0], x_offset : x_offset + view.shape[1]] = view

    # Frame chrome -- letterbox and HUD overlays -- is deliberately left in the
    # stock palette: it is furniture, not board state, and re-skinning it would
    # make status bars unreadable without testing anything about object roles.
    for interface in self._interfaces:
        output = interface.render_interface(output)
    return output


def install() -> None:
    """Monkeypatch `Camera.render`. Idempotent; no game source is modified."""
    global _ORIGINAL_RENDER
    if _ORIGINAL_RENDER is not None:
        return
    from arcengine.camera import Camera

    _ORIGINAL_RENDER = Camera.render
    Camera.render = _patched_render


def uninstall() -> None:
    global _ORIGINAL_RENDER
    if _ORIGINAL_RENDER is None:
        return
    from arcengine.camera import Camera

    Camera.render = _ORIGINAL_RENDER
    _ORIGINAL_RENDER = None
