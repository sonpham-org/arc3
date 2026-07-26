# Loaded - a bank of machines, one of which is worth pulling.
#
# Every machine looks the same. What differs is the distribution behind it, and
# the only way to learn a distribution is to sample it. Fill the bar at the top
# to clear the level; each pull costs an action, so the score for the level is
# really a measure of how quickly the player stopped exploring and committed.
#
# This is the explore/exploit trade-off as a game. The ladder walks through the
# ways a distribution can hide from you:
#
#   hit rate  ->  payout size  ->  downside risk  ->  a finite sampling budget
#   ->  non-stationarity  ->  hidden structure inside the noise  ->  context
#
# Each machine's whole history is drawn under it as a column of outcomes, so the
# evidence an agent needs is on screen rather than in its memory. Nothing about
# which machine is good is stable: the machines are shuffled and their
# parameters jittered every time the level is entered.

import os
import random

import numpy as np
from arcengine import ARCBaseGame, Camera, Level, RenderableUserDisplay

# --- Colors (ARC-3 palette indices) ---
C_WHITE   = 0
C_LGRAY   = 1
C_GRAY    = 2
C_DGRAY   = 3
C_VDARK   = 4
C_BLACK   = 5
C_MAGENTA = 6
C_PINK    = 7
C_RED     = 8
C_BLUE    = 9
C_LBLUE   = 10
C_YELLOW  = 11
C_ORANGE  = 12
C_MAROON  = 13
C_GREEN   = 14
C_PURPLE  = 15

# --- Layout ---
BAR_Y0, BAR_Y1 = 1, 7        # target progress bar
LAMP_Y0, LAMP_Y1 = 9, 15     # context lamp / pull budget
HEAD_Y0, HEAD_Y1 = 18, 28    # machine heads
HIST_Y0 = 30                 # history columns start
HIST_SLOT = 4                # pixels per remembered outcome
HIST_LEN = 8                 # outcomes remembered per machine

LAMP_COLORS = [C_MAGENTA, C_LBLUE, C_ORANGE]

# ============================================================================
# Machines
# ============================================================================
# A machine is a kind plus parameters. Pulling one returns an integer payout.
#
#   constant   always pays `a`
#   bernoulli  pays `a` with probability `p`, else 0
#   trap       pays `a` with probability `p`, else -`b`      (real downside)
#   pity       bernoulli, but a miss streak of `k` forces the next pull to pay
#   drift      bernoulli whose p slides from `p` to `p2` across the level
#   context    bernoulli whose p is chosen by the colour of the lamp

class Machine:
    def __init__(self, kind, params, uses=None):
        self.kind = kind
        self.p = params.get("p", 1.0)
        self.p2 = params.get("p2", self.p)
        self.a = params.get("a", 1)
        self.b = params.get("b", 0)
        self.k = params.get("k", 2)
        self.ps = params.get("ps", [])       # context: one p per lamp colour
        self.uses_left = uses                # None = unlimited
        self.miss_streak = 0
        self.history = []                    # most recent first

    @property
    def dead(self):
        return self.uses_left is not None and self.uses_left <= 0

    def pull(self, rng, lamp, progress):
        """Draw one outcome. `progress` is 0..1 through the level, for drift."""
        if self.dead:
            return 0
        if self.uses_left is not None:
            self.uses_left -= 1

        if self.kind == "constant":
            out = self.a
        elif self.kind == "trap":
            out = self.a if rng.random() < self.p else -self.b
        elif self.kind == "pity":
            if self.miss_streak >= self.k or rng.random() < self.p:
                out = self.a
            else:
                out = 0
        elif self.kind == "drift":
            p = self.p + (self.p2 - self.p) * progress
            out = self.a if rng.random() < p else 0
        elif self.kind == "context":
            p = self.ps[lamp % len(self.ps)] if self.ps else self.p
            out = self.a if rng.random() < p else 0
        else:  # bernoulli
            out = self.a if rng.random() < self.p else 0

        self.miss_streak = 0 if out > 0 else self.miss_streak + 1
        self.history.insert(0, out)
        del self.history[HIST_LEN:]
        return out


# ============================================================================
# Levels
# ============================================================================
# Each spec:
#   target   points needed to clear the level
#   budget   None | max pulls before the level is lost
#   lamp     True if a context lamp is lit and re-rolled every pull
#   uses     None | pulls each machine survives before it breaks
#   machines list of (kind, params); ORDER IS SHUFFLED on entry, so the good
#            machine is never in the same place twice
#
# Every level adds exactly one new idea to the one before it.

LEVELS = [
    # 1 -- one machine, always pays. Press it, watch the bar. That is all.
    dict(name="Free Money", target=6, budget=None, lamp=False, uses=None,
         machines=[("constant", dict(a=1))]),

    # 2 -- NEW: the machine is now a coin. Half your presses do nothing, and
    #      there is still nothing to decide -- so this teaches "nothing
    #      happened" without punishing it.
    dict(name="Coin Flip", target=8, budget=None, lamp=False, uses=None,
         machines=[("bernoulli", dict(p=0.5, a=2))]),

    # 3 -- NEW: a second machine, and they are not the same. One always pays,
    #      one never does. One pull each is enough to tell.
    dict(name="Two Coins", target=12, budget=None, lamp=False, uses=None,
         machines=[("constant", dict(a=2)), ("bernoulli", dict(p=0.0, a=2))]),

    # 4 -- NEW: the difference is now noisy rather than absolute. A single pull
    #      proves nothing; a handful of pulls proves a lot.
    dict(name="Noisy Difference", target=18, budget=None, lamp=False, uses=None,
         machines=[("bernoulli", dict(p=0.90, a=3)),           # EV 2.70
                   ("bernoulli", dict(p=0.07, a=3))]),         # EV 0.21

    # 5 -- NEW: three machines, so it becomes a ranking problem, and the gap
    #      between second and third no longer matters -- only the best does.
    dict(name="Three Way", target=36, budget=30, lamp=False, uses=None,
         machines=[("bernoulli", dict(p=0.85, a=3)),           # EV 2.55
                   ("bernoulli", dict(p=0.05, a=3)),           # EV 0.15
                   ("bernoulli", dict(p=0.03, a=3))]),         # EV 0.09

    # 6 -- NEW: payout SIZE, not just hit rate. The machine that hits almost
    #      every pull is worth a third of the one that almost never does:
    #      expected value is what matters, not how often the light comes on.
    dict(name="How Much, Not How Often", target=100, budget=75, lamp=False, uses=None,
         machines=[("bernoulli", dict(p=0.98, a=1)),           # EV 0.98
                   ("bernoulli", dict(p=0.06, a=2)),           # EV 0.12
                   ("bernoulli", dict(p=0.35, a=7))]),         # EV 2.45

    # 7 -- NEW: downside. Two machines pay big and take points back when they
    #      miss; one of those two is the best on the floor and the other is the
    #      worst, and the wins alone do not tell you which is which.
    dict(name="The Trap", target=66, budget=66, lamp=False, uses=None,
         machines=[("bernoulli", dict(p=0.60, a=3)),           # EV  1.80
                   ("trap", dict(p=0.50, a=4, b=6)),           # EV -1.00
                   ("bernoulli", dict(p=0.08, a=2)),           # EV  0.16
                   ("trap", dict(p=0.35, a=10, b=2))]),        # EV  2.20

    # 8 -- NEW: machines wear out. The dots on each head are the pulls it has
    #      left, so sampling is no longer free -- spend too many pulls learning
    #      and the machine you learned about is dead.
    dict(name="They Wear Out", target=48, budget=50, lamp=False, uses=30,
         machines=[("bernoulli", dict(p=0.80, a=3)),           # EV 2.40
                   ("bernoulli", dict(p=0.05, a=3)),           # EV 0.15
                   ("bernoulli", dict(p=0.03, a=3)),           # EV 0.09
                   ("bernoulli", dict(p=0.04, a=3))]),         # EV 0.12

    # 9 -- NEW: the answer changes. One machine decays as the level goes on and
    #      another improves, so a conclusion drawn early goes stale.
    dict(name="Drift", target=60, budget=70, lamp=False, uses=None,
         machines=[("drift", dict(p=0.90, p2=0.05, a=3)),
                   ("drift", dict(p=0.05, p2=0.90, a=3)),
                   ("bernoulli", dict(p=0.04, a=3)),
                   ("bernoulli", dict(p=0.03, a=3))]),

    # 10 -- NEW: hidden structure. One machine is not memoryless -- two misses
    #       in a row force a hit -- so it pays about every third pull however
    #       cold it looks, and treating it as a coin leaves the level on the
    #       table.
    dict(name="Pity Timer", target=60, budget=92, lamp=False, uses=None,
         machines=[("pity", dict(p=0.10, a=4, k=2)),           # EV ~1.48
                   ("bernoulli", dict(p=0.05, a=3)),           # EV  0.15
                   ("bernoulli", dict(p=0.04, a=3)),           # EV  0.12
                   ("bernoulli", dict(p=0.03, a=3)),           # EV  0.09
                   ("trap", dict(p=0.40, a=5, b=4))]),         # EV -0.40

    # 11 -- NEW: context. The lamp re-rolls its colour every pull, and which
    #       machine is best depends on it. Pooled across colours all three look
    #       identical and mediocre; split by colour, each is either superb or
    #       useless.
    dict(name="Read The Lamp", target=72, budget=68, lamp=True, uses=None,
         machines=[("context", dict(ps=[0.90, 0.05, 0.05], a=3)),
                   ("context", dict(ps=[0.05, 0.90, 0.05], a=3)),
                   ("context", dict(ps=[0.05, 0.05, 0.90], a=3)),
                   ("bernoulli", dict(p=0.04, a=3)),
                   ("bernoulli", dict(p=0.03, a=3))]),

    # 12 -- the whole floor, on a budget: context, drift, a trap, a pity timer,
    #       machines that wear out, and only so many pulls to get it done.
    dict(name="The Whole Floor", target=66, budget=60, lamp=True, uses=34,
         machines=[("context", dict(ps=[0.90, 0.05, 0.05], a=4)),
                   ("context", dict(ps=[0.05, 0.90, 0.05], a=4)),
                   ("drift", dict(p=0.85, p2=0.05, a=4)),
                   ("pity", dict(p=0.08, a=4, k=2)),
                   ("trap", dict(p=0.35, a=6, b=5))]),
]

MAX_MACHINES = max(len(spec["machines"]) for spec in LEVELS)


def build_machines(spec, rng):
    """Instantiate a level's machines: shuffled into new slots, params jittered.

    The jitter matters as much as the shuffle -- without it an agent could learn
    "p=0.85 is the good one" as a number rather than learning to measure.
    """
    templates = list(spec["machines"])
    rng.shuffle(templates)

    machines = []
    for kind, params in templates:
        p = dict(params)
        for key in ("p", "p2"):
            if key in p and 0.0 < p[key] < 1.0:
                p[key] = min(0.95, max(0.05, p[key] + rng.uniform(-0.06, 0.06)))
        if "ps" in p:
            p["ps"] = [min(0.95, max(0.05, v + rng.uniform(-0.06, 0.06))) for v in p["ps"]]
        uses = spec["uses"]
        if uses is not None:
            uses = uses + rng.randint(-2, 2)
        machines.append(Machine(kind, p, uses))
    return machines


# ============================================================================
# Display
# ============================================================================

class Lc01Display(RenderableUserDisplay):
    def __init__(self, game: "Lc01"):
        self.game = game

    def render_interface(self, frame: np.ndarray) -> np.ndarray:
        g = self.game
        frame[:, :] = C_BLACK

        # --- target progress bar ---
        frame[BAR_Y0:BAR_Y1, 0:64] = C_VDARK
        filled = int(round(64 * max(0, min(1.0, g.score / g.target))))
        if filled:
            frame[BAR_Y0:BAR_Y1, 0:filled] = C_GREEN
        # tick every tenth of the target, so the bar reads as a quantity
        for t in range(1, 10):
            x = t * 64 // 10
            frame[BAR_Y0, x] = C_BLACK
            frame[BAR_Y1 - 1, x] = C_BLACK

        # --- context lamp (left) and pull budget (right) ---
        if g.lamp_on:
            frame[LAMP_Y0:LAMP_Y1, 1:13] = LAMP_COLORS[g.lamp % len(LAMP_COLORS)]
            frame[LAMP_Y0, 1:13] = C_DGRAY
            frame[LAMP_Y1 - 1, 1:13] = C_DGRAY
        if g.budget:
            x0 = 16
            width = 63 - x0
            frame[LAMP_Y0 + 2:LAMP_Y1 - 2, x0:63] = C_VDARK
            left = max(0, min(width, round(width * g.pulls_left / g.budget)))
            if left:
                low = g.pulls_left <= max(3, g.budget // 5)
                frame[LAMP_Y0 + 2:LAMP_Y1 - 2, x0:x0 + left] = C_RED if low else C_LBLUE

        # --- machines ---
        n = len(g.machines)
        col_w = 64 // n
        for i, m in enumerate(g.machines):
            x0 = i * col_w + 1
            x1 = x0 + col_w - 2

            # head: dead machines go dark, and the ticks are the button number
            head = C_DGRAY if m.dead else C_GRAY
            frame[HEAD_Y0:HEAD_Y1, x0:x1] = head
            tick_c = C_BLACK if m.dead else C_WHITE
            for t in range(i + 1):
                tx = x0 + 1 + t * 2
                if tx < x1 - 1:
                    frame[HEAD_Y1 - 4:HEAD_Y1 - 1, tx] = tick_c

            # remaining pulls, as a row of dots along the top of the head
            if m.uses_left is not None:
                span = max(0, x1 - x0 - 2)
                left = max(0, min(span, m.uses_left))
                frame[HEAD_Y0 + 1:HEAD_Y0 + 3, x0 + 1:x0 + 1 + left] = C_YELLOW

            # history: most recent outcome on top, bar length = size of payout
            for j, out in enumerate(m.history):
                y = HIST_Y0 + j * HIST_SLOT
                if y + HIST_SLOT - 1 > 63:
                    break
                frame[y:y + HIST_SLOT - 1, x0:x1] = C_VDARK
                if out == 0:
                    continue
                mag = min(1.0, abs(out) / 8.0)
                length = max(1, int(round((x1 - x0) * mag)))
                color = C_GREEN if out > 0 else C_RED
                if out > 0:
                    frame[y:y + HIST_SLOT - 1, x0:x0 + length] = color
                else:
                    frame[y:y + HIST_SLOT - 1, x1 - length:x1] = color

        return frame


# ============================================================================
# Game
# ============================================================================

class Lc01(ARCBaseGame):
    def __init__(self):
        # Fixed master seed, re-drawn per level entry: the machines are new on
        # every entry (including after a RESET) so nothing can be memorised,
        # but two harness runs still meet the identical sequence of luck, which
        # keeps a stochastic game from adding noise to the benchmark score.
        # LC01_SEED re-seeds it, for calibration sweeps only.
        self._master_rng = random.Random(int(os.getenv("LC01_SEED", 0x10ADED)))
        self._rng = random.Random(0)

        self.display = Lc01Display(self)

        self.machines = []
        self.score = 0
        self.target = 1
        self.budget = 0
        self.pulls_left = 0
        self.lamp_on = False
        self.lamp = 0

        levels = [
            Level(sprites=[], grid_size=(64, 64), data=spec, name=spec["name"])
            for spec in LEVELS
        ]

        super().__init__(
            "lc",
            levels,
            Camera(0, 0, 64, 64, C_BLACK, C_BLACK, [self.display]),
            False,
            len(levels),
            list(range(1, MAX_MACHINES + 1)),  # one button per machine slot
        )

    def on_set_level(self, level: Level) -> None:
        spec = LEVELS[self.level_index]
        self._rng = random.Random(self._master_rng.getrandbits(48))

        self.machines = build_machines(spec, self._rng)
        self.score = 0
        self.target = spec["target"]
        self.budget = spec["budget"] or 0
        self.pulls_left = self.budget
        self.lamp_on = spec["lamp"]
        self.lamp = self._rng.randrange(len(LAMP_COLORS)) if self.lamp_on else 0

    def step(self) -> None:
        idx = self.action.id.value - 1
        if not (0 <= idx < len(self.machines)):
            self.complete_action()
            return

        progress = min(1.0, self.score / self.target) if self.target else 0.0
        payout = self.machines[idx].pull(self._rng, self.lamp, progress)
        self.score = max(0, self.score + payout)

        if self.budget:
            self.pulls_left -= 1

        if self.lamp_on:
            self.lamp = self._rng.randrange(len(LAMP_COLORS))

        if self.score >= self.target:
            self.next_level()
            self.complete_action()
            return

        if self.budget and self.pulls_left <= 0:
            self.lose()

        self.complete_action()
