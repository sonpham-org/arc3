# Drunken Steps - a maze where you do not choose how FAR you go.
#
# A die is shown each turn. Pressing a direction moves you exactly that many
# tiles (you stop short at walls, and you LEAP OVER pits mid-stride -- only the
# tile you LAND on can hurt you). ACTION5 re-rolls the die, at the cost of a turn.
#
# The randomness here is INPUT randomness: the roll is revealed before you
# commit, so the game rewards planning over a stochastic move set rather than
# punishing a plan after the fact. Later levels layer OUTPUT randomness on top
# (slip: sometimes you travel one further than shown) and a randomly-walking
# guard, so safety margins start to matter more than shortest paths.
#
# Two things keep it from being a memorisation exercise:
#
#   * Every level is GENERATED. Entering a level -- including re-entering it
#     after a RESET -- builds a brand new maze from that level's spec, so an
#     agent can learn the rules but never a layout.
#   * The world is bigger than the screen. Levels grow from a single 16x13
#     screen to a 3x3 block of them; the view flips screen-to-screen as you
#     cross a boundary, and the little screen-map in the corner is the only
#     thing telling you which screen the exit is on.

import os
import random

import numpy as np
from arcengine import ARCBaseGame, Camera, Level, RenderableUserDisplay

# --- Layout ---
CELL = 4                     # pixels per maze tile
STRIP_H = 12                 # status strip occupies rows 0..11
VIEW_W = 64 // CELL          # 16 tiles across per screen
VIEW_H = (64 - STRIP_H) // CELL   # 13 tiles down per screen
DIE = 11                     # die face is DIE x DIE pixels

# --- Colors (ARC-3 palette indices) ---
C_WHITE   = 0
C_LGRAY   = 1
C_GRAY    = 2
C_DGRAY   = 3
C_VDARK   = 4
C_BLACK   = 5
C_PINK    = 7
C_RED     = 8
C_BLUE    = 9
C_LBLUE   = 10
C_YELLOW  = 11
C_ORANGE  = 12
C_MAROON  = 13
C_GREEN   = 14
C_PURPLE  = 15

# --- Tiles ---
T_WALL   = 1
T_FLOOR  = 2
T_PIT    = 3
T_GOAL   = 4
T_DOOR   = 6

DIRS4 = ((0, -1), (0, 1), (-1, 0), (1, 0))

# ============================================================================
# Level specs
# ============================================================================
# Each spec drives the generator:
#   sx, sy    world size in SCREENS (each screen is VIEW_W x VIEW_H tiles)
#   openness  0.0 = tight 1-wide maze, 1.0 = wide-open room
#   pit       fraction of floor tiles that become pits
#   keys      number of keys stranded behind a door on the near side
#   faces     [(value, weight)] the die's support and its bias
#   two_dice  separate dice for horizontal / vertical movement
#   slip      chance a move travels one tile FURTHER than shown
#   guard     None | "walk" | "chase"
#   fuel      None | int action budget; running out loses the level
#
# Every level adds exactly one new idea to the one before it, and the world
# grows from 1 screen to 9.

LEVELS = [
    # 1 -- one screen, one room. The d-pad moves you, green is the exit, and
    #      the die is pinned to 1 so nothing else is going on yet.
    dict(name="One Step", sx=1, sy=1, openness=1.0, pit=0.0, keys=0,
         faces=[(1, 1)], two_dice=False, slip=0.0, guard=None, fuel=None),

    # 2 -- NEW: the die actually rolls (1 or 2). The number is your stride.
    dict(name="The Die Rolls", sx=1, sy=1, openness=0.9, pit=0.0, keys=0,
         faces=[(1, 1), (2, 1)], two_dice=False, slip=0.0, guard=None, fuel=None),

    # 3 -- NEW: real walls, and they truncate a stride. Roll a 3 at a wall one
    #      tile away and you move 1. Overshooting is still free here.
    dict(name="Walls Cut You Short", sx=1, sy=1, openness=0.22, pit=0.0, keys=0,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=False, slip=0.0, guard=None, fuel=None),

    # 4 -- NEW: pits, and a world twice as wide as the screen. You LEAP pits
    #      mid-stride, so only the tile you LAND on matters; land in one and
    #      you are thrown back to the start. The view now scrolls.
    dict(name="Leap The Pits", sx=2, sy=1, openness=0.85, pit=0.16, keys=0,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=False, slip=0.0, guard=None, fuel=None),

    # 5 -- NEW: the re-roll (ACTION5). Pits get dense enough that most rolls
    #      are unusable, so the way through is to pay a turn for a new stride.
    dict(name="Pay To Re-Roll", sx=2, sy=1, openness=0.55, pit=0.30, keys=0,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=False, slip=0.0, guard=None, fuel=None),

    # 6 -- NEW: keys and a locked door, across four screens. Keys are picked up
    #      by LANDING on them, never by leaping over them, so the stride
    #      constrains your shopping list and not just your route.
    dict(name="Land On The Keys", sx=2, sy=2, openness=0.35, pit=0.10, keys=2,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=False, slip=0.0, guard=None, fuel=None),

    # 7 -- NEW: the die is LOADED. A 3 comes up eight times as often as a 1 or
    #      a 2, so re-rolling for a short stride is expensive. Route in threes.
    dict(name="Loaded Die", sx=2, sy=2, openness=0.9, pit=0.18, keys=0,
         faces=[(1, 1), (2, 1), (3, 8)], two_dice=False, slip=0.0, guard=None, fuel=None),

    # 8 -- NEW: two dice. The left (white) die is your left/right stride, the
    #      right (blue) die is your up/down stride. They roll independently.
    dict(name="Two Dice", sx=3, sy=2, openness=0.45, pit=0.14, keys=0,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=True, slip=0.0, guard=None, fuel=None),

    # 9 -- NEW: slip. About a third of the time you travel one tile FURTHER
    #      than the die shows. Output randomness at last: the die stops telling
    #      you where you land, so pits need a margin of safety.
    dict(name="Slippery", sx=3, sy=2, openness=0.85, pit=0.20, keys=0,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=False, slip=0.30, guard=None, fuel=None),

    # 10 -- NEW: a guard on a random walk, in a nine-screen maze. It has no
    #       plan, which is exactly the problem: it cannot be predicted, only
    #       kept at a distance.
    dict(name="Random Guard", sx=3, sy=3, openness=0.40, pit=0.10, keys=0,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=False, slip=0.0, guard="walk", fuel=None),

    # 11 -- NEW: fuel. Every action burns 1 and every re-roll burns 3, so
    #       re-rolling until the die is perfect will strand you. When is a bad
    #       roll worth taking anyway?
    dict(name="Fuel Is Finite", sx=3, sy=3, openness=0.45, pit=0.14, keys=2,
         faces=[(1, 1), (2, 1), (3, 1)], two_dice=False, slip=0.0, guard=None, fuel=420),

    # 12 -- everything at once across all nine screens: a loaded pair of dice,
    #       slip, a guard that actually hunts, keys behind a door, a budget.
    dict(name="Last Call", sx=3, sy=3, openness=0.55, pit=0.16, keys=2,
         faces=[(1, 2), (2, 1), (3, 4)], two_dice=True, slip=0.25, guard="chase", fuel=620),
]


# ============================================================================
# World generation
# ============================================================================

def _carve(rng, w, h):
    """Randomised-DFS perfect maze on odd cells. Returns a tile grid."""
    grid = [[T_WALL] * w for _ in range(h)]
    grid[1][1] = T_FLOOR
    stack = [(1, 1)]
    while stack:
        x, y = stack[-1]
        options = []
        for dx, dy in DIRS4:
            nx, ny = x + dx * 2, y + dy * 2
            if 1 <= nx < w - 1 and 1 <= ny < h - 1 and grid[ny][nx] == T_WALL:
                options.append((nx, ny, x + dx, y + dy))
        if not options:
            stack.pop()
            continue
        nx, ny, mx, my = rng.choice(options)
        grid[my][mx] = T_FLOOR
        grid[ny][nx] = T_FLOOR
        stack.append((nx, ny))
    return grid


def _open_up(rng, grid, w, h, openness):
    """Knock out interior walls, braiding the maze or melting it into rooms."""
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if grid[y][x] == T_WALL and rng.random() < openness:
                grid[y][x] = T_FLOOR


def _flood(grid, w, h, src, blocked=()):
    seen = {src}
    stack = [src]
    while stack:
        x, y = stack.pop()
        for dx, dy in DIRS4:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            if (nx, ny) in seen or (nx, ny) in blocked:
                continue
            if grid[ny][nx] == T_WALL:
                continue
            seen.add((nx, ny))
            stack.append((nx, ny))
    return seen


def _farthest(grid, w, h, src):
    """The floor tile furthest from src by plain walking distance."""
    import collections
    dist = {src: 0}
    dq = collections.deque([src])
    far, fd = src, 0
    while dq:
        x, y = dq.popleft()
        if dist[(x, y)] > fd:
            far, fd = (x, y), dist[(x, y)]
        for dx, dy in DIRS4:
            nx, ny = x + dx, y + dy
            if (0 <= nx < w and 0 <= ny < h and (nx, ny) not in dist
                    and grid[ny][nx] != T_WALL):
                dist[(nx, ny)] = dist[(x, y)] + 1
                dq.append((nx, ny))
    return far, fd


def _stride_reachable(grid, w, h, start, goal, keys, door, supports):
    """Is the exit actually reachable under the game's own landing rule?

    A stride stops at walls (and at a shut door), leaps pits, and only the
    landing tile counts -- so plain flood-fill connectivity is not enough.
    """
    import collections

    def land(pos, d, stride, keys_left):
        dx, dy = DIRS4[d]
        x, y = pos
        for _ in range(stride):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h):
                break
            if grid[ny][nx] == T_WALL:
                break
            if (nx, ny) == door and keys_left:
                break
            x, y = nx, ny
        return (x, y)

    st0 = (start, frozenset(keys))
    seen = {st0}
    dq = collections.deque([st0])
    while dq:
        pos, kl = dq.popleft()
        if pos == goal and not kl:
            return True
        for d in range(4):
            for s in supports:
                nxt = land(pos, d, s, kl)
                if nxt == pos or grid[nxt[1]][nxt[0]] == T_PIT:
                    continue
                stn = (nxt, kl - {nxt})
                if stn not in seen:
                    seen.add(stn)
                    dq.append(stn)
    return False


def generate(spec, rng, attempts=40):
    """Build one playable world for a level spec. Never returns an unsolvable one."""
    w, h = spec["sx"] * VIEW_W, spec["sy"] * VIEW_H
    supports = sorted({v for v, _ in spec["faces"]})

    for _ in range(attempts):
        grid = _carve(rng, w, h)
        _open_up(rng, grid, w, h, spec["openness"])

        floors = [(x, y) for y in range(h) for x in range(w) if grid[y][x] == T_FLOOR]
        if len(floors) < 12:
            continue

        # Start and exit at opposite ends of the world's longest corridor, so a
        # multi-screen world actually has to be crossed.
        a, _ = _farthest(grid, w, h, rng.choice(floors))
        start, span = _farthest(grid, w, h, a)
        start, goal = a, start
        if span < (w + h) // 4:
            continue

        # A door on a tile that genuinely separates start from exit, with the
        # keys stranded on the near side, so the lock really does gate progress.
        door, keys = None, []
        if spec["keys"]:
            candidates = [c for c in floors if c not in (start, goal)]
            rng.shuffle(candidates)
            for c in candidates:
                near = _flood(grid, w, h, start, blocked={c})
                if goal in near:
                    continue  # not a separator
                pool = [p for p in near if p not in (start, goal)]
                if len(pool) < spec["keys"] + 2:
                    continue
                door = c
                keys = rng.sample(pool, spec["keys"])
                break
            if door is None:
                continue

        reserved = {start, goal, door, *keys}
        for (x, y) in floors:
            if (x, y) not in reserved and rng.random() < spec["pit"]:
                grid[y][x] = T_PIT

        grid[goal[1]][goal[0]] = T_GOAL
        if door:
            grid[door[1]][door[0]] = T_DOOR

        if not _stride_reachable(grid, w, h, start, goal, keys, door, supports):
            continue

        guard = None
        if spec["guard"]:
            far = [p for p in floors
                   if grid[p[1]][p[0]] == T_FLOOR and p not in reserved
                   and abs(p[0] - start[0]) + abs(p[1] - start[1]) > (w + h) // 6]
            if far:
                guard = rng.choice(far)

        return grid, start, goal, set(keys), door, guard

    # Fallback: a plain open room, which is always solvable.
    grid = [[T_WALL if (x in (0, w - 1) or y in (0, h - 1)) else T_FLOOR
             for x in range(w)] for y in range(h)]
    grid[h - 2][w - 2] = T_GOAL
    return grid, (1, 1), (w - 2, h - 2), set(), None, None


# ============================================================================
# Display
# ============================================================================

# 2x2 pip positions inside the DIE x DIE face, by value.
PIP_SLOTS = {
    1: [(4, 4)],
    2: [(1, 1), (7, 7)],
    3: [(1, 1), (4, 4), (7, 7)],
    4: [(1, 1), (7, 1), (1, 7), (7, 7)],
    5: [(1, 1), (7, 1), (4, 4), (1, 7), (7, 7)],
    6: [(1, 1), (7, 1), (1, 4), (7, 4), (1, 7), (7, 7)],
}


class Dw01Display(RenderableUserDisplay):
    def __init__(self, game: "Dw01"):
        self.game = game

    def _draw_die(self, frame, ox, oy, value, face_color):
        frame[oy:oy + DIE, ox:ox + DIE] = face_color
        frame[oy, ox:ox + DIE] = C_DGRAY
        frame[oy + DIE - 1, ox:ox + DIE] = C_DGRAY
        frame[oy:oy + DIE, ox] = C_DGRAY
        frame[oy:oy + DIE, ox + DIE - 1] = C_DGRAY
        for (px, py) in PIP_SLOTS.get(value, []):
            frame[oy + py + 1:oy + py + 3, ox + px + 1:ox + px + 3] = C_BLACK

    def _core(self, frame, px, py, color):
        frame[py + 1:py + CELL - 1, px + 1:px + CELL - 1] = color

    def _draw_screen_map(self, frame, g):
        """Which screen am I on, which screens have I seen, where is the exit?

        In a world bigger than the display this is the only global information
        the player gets -- and it is what makes a nine-screen maze navigable
        without turning the level into a blind search.
        """
        if g.sx * g.sy <= 1:
            return
        pip, gap = 3, 1
        mw = g.sx * (pip + gap) - gap
        mh = g.sy * (pip + gap) - gap
        ox, oy = 63 - mw, (STRIP_H - mh) // 2
        gsx, gsy = g.goal[0] // VIEW_W, g.goal[1] // VIEW_H
        for syi in range(g.sy):
            for sxi in range(g.sx):
                x = ox + sxi * (pip + gap)
                y = oy + syi * (pip + gap)
                if (sxi, syi) == (gsx, gsy):
                    color = C_GREEN
                elif (sxi, syi) in g.seen_screens:
                    color = C_GRAY
                else:
                    color = C_VDARK
                frame[y:y + pip, x:x + pip] = color
                if (sxi, syi) == (g.cam_sx, g.cam_sy):
                    frame[y + 1, x + 1] = C_WHITE

    def render_interface(self, frame: np.ndarray) -> np.ndarray:
        g = self.game
        frame[:, :] = C_BLACK

        # --- status strip ---
        self._draw_die(frame, 1, 0, g.stride_h, C_WHITE)
        if g.two_dice:
            self._draw_die(frame, 13, 0, g.stride_v, C_LBLUE)
        self._draw_screen_map(frame, g)

        hud_x = 26 if g.two_dice else 14
        hud_end = 63 - (g.sx * 4 - 1) - 2 if g.sx * g.sy > 1 else 62
        for i in range(g.keys_total):
            kx = hud_x + i * 4
            if kx + 3 > hud_end:
                break
            frame[7:10, kx:kx + 3] = C_GREEN if i < g.keys_collected else C_YELLOW

        if g.fuel_max and hud_end - hud_x > 4:
            width = hud_end - hud_x
            frame[2:5, hud_x:hud_end] = C_VDARK
            filled = max(0, min(width, round(width * g.fuel / g.fuel_max)))
            if filled:
                low = g.fuel <= g.fuel_max // 4
                frame[2:5, hud_x:hud_x + filled] = C_RED if low else C_GREEN

        # --- the one screen of the world we can currently see ---
        tx0, ty0 = g.cam_sx * VIEW_W, g.cam_sy * VIEW_H
        door_open = g.keys_collected >= g.keys_total
        for vy in range(VIEW_H):
            for vx in range(VIEW_W):
                wx, wy = tx0 + vx, ty0 + vy
                px, py = vx * CELL, STRIP_H + vy * CELL
                tile = g.grid[wy][wx]
                if tile == T_WALL:
                    frame[py:py + CELL, px:px + CELL] = C_DGRAY
                elif tile == T_FLOOR:
                    frame[py:py + CELL, px:px + CELL] = C_LGRAY
                elif tile == T_PIT:
                    frame[py:py + CELL, px:px + CELL] = C_MAROON
                    self._core(frame, px, py, C_BLACK)
                elif tile == T_GOAL:
                    frame[py:py + CELL, px:px + CELL] = C_GREEN
                    if not door_open:
                        self._core(frame, px, py, C_RED)
                elif tile == T_DOOR:
                    if door_open:
                        frame[py:py + CELL, px:px + CELL] = C_LGRAY
                    else:
                        frame[py:py + CELL, px:px + CELL] = C_PURPLE
                        self._core(frame, px, py, C_BLACK)

                if (wx, wy) in g.remaining_keys:
                    self._core(frame, px, py, C_YELLOW)

        def on_screen(pos):
            return tx0 <= pos[0] < tx0 + VIEW_W and ty0 <= pos[1] < ty0 + VIEW_H

        if g.guard_pos is not None and on_screen(g.guard_pos):
            px = (g.guard_pos[0] - tx0) * CELL
            py = STRIP_H + (g.guard_pos[1] - ty0) * CELL
            frame[py:py + CELL, px:px + CELL] = C_RED
            self._core(frame, px, py, C_PINK)

        if on_screen(g.player):
            px = (g.player[0] - tx0) * CELL
            py = STRIP_H + (g.player[1] - ty0) * CELL
            frame[py:py + CELL, px:px + CELL] = C_BLUE
            self._core(frame, px, py, C_WHITE)

        return frame


# ============================================================================
# Game
# ============================================================================

class Dw01(ARCBaseGame):
    def __init__(self):
        # One master stream for the whole session. Every level entry (including
        # a RESET-driven retry) draws a fresh sub-seed from it, so both the maze
        # and the dice are new each time -- an agent can memorise the rules but
        # never a layout -- while a whole run from process start stays
        # bit-for-bit reproducible.
        #
        # The master seed is FIXED on purpose: the agent still cannot predict
        # the stream, but two harness runs face the identical sequence of luck,
        # which stops a stochastic game from adding run-to-run noise to the
        # benchmark score. DW01_SEED re-seeds it, for calibration sweeps only.
        self._master_rng = random.Random(int(os.getenv("DW01_SEED", 0xD0FF_0DE5)))
        self._rng = random.Random(0)

        self.display = Dw01Display(self)

        self.grid = []
        self.rows = self.cols = 0
        self.sx = self.sy = 1
        self.cam_sx = self.cam_sy = 0
        self.seen_screens = set()
        self.player = self.start = self.goal = (0, 0)
        self.door = None
        self.remaining_keys = set()
        self.keys_total = self.keys_collected = 0
        self.guard_pos = None
        self.guard_mode = None
        self.stride_h = self.stride_v = 1
        self.two_dice = False
        self.slip = 0.0
        self.fuel = self.fuel_max = 0
        self._faces = [(1, 1)]
        self._anim = []

        levels = [
            Level(sprites=[], grid_size=(64, 64), data=spec, name=spec["name"])
            for spec in LEVELS
        ]

        super().__init__(
            "dw",
            levels,
            Camera(0, 0, 64, 64, C_BLACK, C_BLACK, [self.display]),
            False,
            len(levels),
            [1, 2, 3, 4, 5],  # d-pad + re-roll
        )

    # -- setup -------------------------------------------------------------

    def on_set_level(self, level: Level) -> None:
        spec = LEVELS[self.level_index]
        self._rng = random.Random(self._master_rng.getrandbits(48))

        grid, start, goal, keys, door, guard = generate(spec, self._rng)
        self.grid = grid
        self.sx, self.sy = spec["sx"], spec["sy"]
        self.cols, self.rows = self.sx * VIEW_W, self.sy * VIEW_H
        self.start = self.player = start
        self.goal = goal
        self.door = door
        self.remaining_keys = set(keys)
        self.keys_total = len(keys)
        self.keys_collected = 0
        self.guard_pos = guard
        self.guard_mode = spec["guard"]

        self.two_dice = spec["two_dice"]
        self.slip = spec["slip"]
        self._faces = spec["faces"]
        self.fuel_max = spec["fuel"] or 0
        self.fuel = self.fuel_max

        self.seen_screens = set()
        self._follow_camera()
        self._anim = []
        self._roll_dice()

    def _follow_camera(self) -> None:
        """The view shows whole screens: crossing an edge flips to the next one."""
        self.cam_sx = min(self.sx - 1, self.player[0] // VIEW_W)
        self.cam_sy = min(self.sy - 1, self.player[1] // VIEW_H)
        self.seen_screens.add((self.cam_sx, self.cam_sy))

    def _roll_dice(self) -> None:
        values = [v for v, _ in self._faces]
        weights = [w for _, w in self._faces]
        self.stride_h = self._rng.choices(values, weights=weights)[0]
        self.stride_v = (self._rng.choices(values, weights=weights)[0]
                         if self.two_dice else self.stride_h)

    # -- helpers -----------------------------------------------------------

    def _blocked(self, x, y) -> bool:
        """True if (x, y) stops a stride: off-map, wall, or a shut door."""
        if not (0 <= x < self.cols and 0 <= y < self.rows):
            return True
        if self.grid[y][x] == T_WALL:
            return True
        if (x, y) == self.door and self.keys_collected < self.keys_total:
            return True
        return False

    def _move_guard(self) -> None:
        if self.guard_pos is None:
            return
        gx, gy = self.guard_pos
        options = [(gx, gy)]
        for dx, dy in DIRS4:
            nx, ny = gx + dx, gy + dy
            if not self._blocked(nx, ny) and self.grid[ny][nx] != T_PIT:
                options.append((nx, ny))
        if self.guard_mode == "chase" and self._rng.random() < 0.6:
            px, py = self.player
            self.guard_pos = min(options, key=lambda p: abs(p[0] - px) + abs(p[1] - py))
        else:
            self.guard_pos = self._rng.choice(options)

    def _spend_fuel(self, amount: int) -> None:
        if self.fuel_max:
            self.fuel = max(0, self.fuel - amount)

    # -- main loop ---------------------------------------------------------

    def step(self) -> None:
        # Mid-move: pay out one tile of travel per frame, so the stride (and any
        # slip past it) is visible rather than teleporting.
        if self._anim:
            self.player = self._anim.pop(0)
            self._follow_camera()
            if not self._anim:
                self._resolve_landing()
            return

        aid = self.action.id.value

        if aid == 5:
            self._spend_fuel(3)
            self._roll_dice()
            self._after_turn()
            return

        dirs = {1: (0, -1), 2: (0, 1), 3: (-1, 0), 4: (1, 0)}
        if aid not in dirs:
            self.complete_action()
            return

        dx, dy = dirs[aid]
        stride = self.stride_h if dx else self.stride_v
        if self.slip and self._rng.random() < self.slip:
            stride += 1

        path = []
        x, y = self.player
        for _ in range(stride):
            nx, ny = x + dx, y + dy
            if self._blocked(nx, ny):
                break
            x, y = nx, ny
            path.append((x, y))

        self._spend_fuel(1)
        if not path:
            # Walked straight into a wall: the turn and the roll are spent.
            self._roll_dice()
            self._after_turn()
            return

        self._anim = path
        self.player = self._anim.pop(0)
        self._follow_camera()
        if not self._anim:
            self._resolve_landing()

    def _resolve_landing(self) -> None:
        """Apply whatever the tile we came to rest on does, then end the turn."""
        px, py = self.player
        tile = self.grid[py][px]

        if tile == T_PIT:
            self.player = self.start
        elif self.player in self.remaining_keys:
            self.remaining_keys.discard(self.player)
            self.keys_collected += 1

        if tile == T_GOAL and self.keys_collected >= self.keys_total:
            self._roll_dice()
            self.next_level()
            self.complete_action()
            return

        self._roll_dice()
        self._after_turn()

    def _after_turn(self) -> None:
        self._move_guard()
        if self.guard_pos is not None and self.guard_pos == self.player:
            self.player = self.start
        self._follow_camera()
        if self.fuel_max and self.fuel <= 0:
            self.lose()
        self.complete_action()
