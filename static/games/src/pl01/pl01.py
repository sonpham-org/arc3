# Press Your Luck - knowing when to stop is the whole game.
#
# PUSH and gems pile up in front of you. They are not yours yet: push once too
# often and the pile is gone. BANK sweeps the pile into the vault, where it is
# safe, and the vault is what the level asks you to fill.
#
# Nothing here is about finding a hidden best option -- there is only one lever
# and it always pays. The question is purely when to stop, which makes this the
# optimal-stopping counterpart to a bandit game: the risk is known (eventually),
# the reward is known, and the skill is in the threshold.
#
# The ladder walks through the ways that threshold gets harder to find:
#
#   no risk -> flat risk -> risk that grows with the pile -> risk you cannot see
#   -> random reward sizes -> a choice of two risk/reward profiles -> insurance
#   -> a deadline that forces you to gamble -> busts that eat the vault too
#   -> a hidden streak bonus -> a fee for banking
#
# Everything is regenerated on entry: bust curves, reward spreads, and which
# side the safe urn is on are all re-rolled, so only the rules transfer.

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
VAULT_Y0, VAULT_Y1 = 1, 8        # vault / target bar
INFO_Y0, INFO_Y1 = 10, 15        # turn budget + insurance shield
PILE_Y0 = 17                     # gem pile grid
PILE_COLS, PILE_ROWS, GEM = 12, 5, 5
PILE_Y1 = PILE_Y0 + PILE_ROWS * GEM
URN_Y0, URN_Y1 = 44, 63          # urns

# ============================================================================
# Levels
# ============================================================================
# Each spec:
#   target     gems the vault needs
#   turns      None | action budget; running out loses the level
#   urns       list of urn dicts, ORDER SHUFFLED on entry:
#                base   bust chance with an empty pile
#                slope  extra bust chance per gem already on the pile
#                cap    maximum bust chance
#                lo,hi  reward drawn uniformly from lo..hi
#                shown  True if the urn's current bust chance is displayed
#   insure     None | premium in gems for ACTION4 to make one push safe
#   ruin       gems a bust also tears out of the VAULT (0 = pile only)
#   streak     None | pushes in a row that trigger a hidden bonus payout
#   bonus      gems awarded when that streak lands
#   bank_fee   gems burned every time you bank
#
# Controls are fixed across all twelve levels so they can be learned once:
#   ACTION1 push left urn, ACTION2 push right urn, ACTION3 bank, ACTION4 insure.
# On levels without a right urn or without insurance those buttons do nothing,
# which is itself something to discover.

LEVELS = [
    # 1 -- no risk at all. Push builds a pile, bank turns it into progress.
    #      Two verbs, and the only way to win is to use both.
    dict(name="Just Push", target=8, turns=None, insure=None, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.0, slope=0.0, cap=0.0, lo=1, hi=1, shown=True)]),

    # 2 -- NEW: the pile can be lost. A flat one-in-six per push, and the meter
    #      on the urn says so, so the only new idea is "banking is not optional".
    dict(name="It Can Bust", target=14, turns=None, insure=None, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.17, slope=0.0, cap=0.17, lo=2, hi=2, shown=True)]),

    # 3 -- NEW: the risk GROWS with the pile. Now there is a real threshold --
    #      a pile size past which one more push is a losing bet -- and the meter
    #      still shows you where you are on the curve.
    dict(name="Risk Grows", target=24, turns=None, insure=None, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.03, slope=0.045, cap=0.75, lo=2, hi=2, shown=True)]),

    # 4 -- NEW: the meter goes dark. Same shape of curve, but it has to be
    #      inferred from busts rather than read off the urn.
    dict(name="Hidden Hazard", target=30, turns=None, insure=None, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.03, slope=0.045, cap=0.75, lo=2, hi=2, shown=False)]),

    # 5 -- NEW: the reward is random too. The threshold stops being a number of
    #      pushes and becomes a number of gems.
    dict(name="Uneven Payouts", target=40, turns=None, insure=None, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.03, slope=0.05, cap=0.80, lo=1, hi=5, shown=False)]),

    # 6 -- NEW: a second urn, and ACTION2 wakes up. One is slow and safe, one is
    #      fast and dangerous, and which side is which changes every entry.
    dict(name="Two Urns", target=90, turns=None, insure=None, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.02, slope=0.030, cap=0.60, lo=1, hi=3, shown=False),
               dict(base=0.06, slope=0.075, cap=0.85, lo=4, hi=8, shown=False)]),

    # 7 -- NEW: insurance. ACTION4 burns gems off the pile to make exactly one
    #      push unbustable -- worth it only when the pile is big enough that the
    #      premium is cheaper than the risk.
    dict(name="Buy Insurance", target=100, turns=None, insure=3, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.03, slope=0.045, cap=0.80, lo=2, hi=4, shown=False),
               dict(base=0.08, slope=0.080, cap=0.90, lo=5, hi=9, shown=False)]),

    # 8 -- NEW: a deadline. Banking small and often is safe and now also too
    #      slow, so the correct amount of risk goes UP as the clock runs down.
    dict(name="Beat The Clock", target=100, turns=62, insure=3, ruin=0,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.03, slope=0.045, cap=0.80, lo=2, hi=4, shown=False),
               dict(base=0.08, slope=0.080, cap=0.90, lo=5, hi=9, shown=False)]),

    # 9 -- NEW: risk of ruin. A bust no longer just clears the pile, it tears
    #       gems out of the vault as well, so there is no longer any such thing
    #       as locked-in progress.
    dict(name="Risk Of Ruin", target=110, turns=None, insure=3, ruin=5,
         streak=None, bonus=0, bank_fee=0,
         urns=[dict(base=0.03, slope=0.045, cap=0.80, lo=2, hi=4, shown=False),
               dict(base=0.08, slope=0.080, cap=0.90, lo=5, hi=9, shown=False)]),

    # 10 -- NEW: a hidden streak bonus. Three clean pushes in a row triple the
    #       a fat bonus payout, which pushes the correct stopping point out past
    #       where the hazard curve alone would put it. Nothing announces this.
    dict(name="Three In A Row", target=80, turns=None, insure=3, ruin=0,
         streak=3, bonus=12, bank_fee=0,
         urns=[dict(base=0.04, slope=0.050, cap=0.80, lo=1, hi=3, shown=False),
               dict(base=0.09, slope=0.085, cap=0.90, lo=3, hi=6, shown=False)]),

    # 11 -- NEW: banking costs gems. Cashing out early is no longer free, so the
    #       safe strategy of banking after every push quietly bleeds the level.
    dict(name="The Teller Takes A Cut", target=110, turns=None, insure=3, ruin=0,
         streak=None, bonus=0, bank_fee=2,
         urns=[dict(base=0.03, slope=0.045, cap=0.80, lo=2, hi=4, shown=False),
               dict(base=0.08, slope=0.080, cap=0.90, lo=5, hi=9, shown=False)]),

    # 12 -- all of it: two hidden curves, a streak bonus, ruin on every bust, a
    #       banking fee, insurance worth buying, and a clock.
    dict(name="Last Spin", target=110, turns=80, insure=3, ruin=4,
         streak=3, bonus=14, bank_fee=2,
         urns=[dict(base=0.04, slope=0.050, cap=0.85, lo=2, hi=5, shown=False),
               dict(base=0.09, slope=0.085, cap=0.92, lo=5, hi=10, shown=False)]),
]

MAX_URNS = max(len(spec["urns"]) for spec in LEVELS)
URN_COLORS = [C_PURPLE, C_ORANGE]


class Urn:
    def __init__(self, cfg):
        self.base = cfg["base"]
        self.slope = cfg["slope"]
        self.cap = cfg["cap"]
        self.lo = cfg["lo"]
        self.hi = cfg["hi"]
        self.shown = cfg["shown"]

    def bust_chance(self, pile):
        return min(self.cap, self.base + self.slope * pile)

    def reward(self, rng):
        return rng.randint(self.lo, self.hi)


def build_urns(spec, rng):
    """Instantiate a level's urns: shuffled between the two slots, jittered.

    Without the jitter an agent could learn the hazard curve as a constant
    instead of learning to measure one; without the shuffle it could learn
    "the right-hand urn is the safe one".
    """
    cfgs = [dict(c) for c in spec["urns"]]
    rng.shuffle(cfgs)
    for c in cfgs:
        if c["base"] > 0:
            c["base"] = max(0.01, c["base"] + rng.uniform(-0.015, 0.015))
        if c["slope"] > 0:
            c["slope"] = max(0.01, c["slope"] + rng.uniform(-0.010, 0.010))
    return [Urn(c) for c in cfgs]


# ============================================================================
# Display
# ============================================================================

class Pl01Display(RenderableUserDisplay):
    def __init__(self, game: "Pl01"):
        self.game = game

    def render_interface(self, frame: np.ndarray) -> np.ndarray:
        g = self.game
        frame[:, :] = C_BLACK

        # --- vault: the only progress that counts ---
        frame[VAULT_Y0:VAULT_Y1, 0:64] = C_VDARK
        filled = int(round(64 * max(0.0, min(1.0, g.vault / g.target))))
        if filled:
            frame[VAULT_Y0:VAULT_Y1, 0:filled] = C_GREEN
        for t in range(1, 8):
            x = t * 8
            frame[VAULT_Y0, x] = C_BLACK
            frame[VAULT_Y1 - 1, x] = C_BLACK

        # --- insurance shield (left) and the clock (right) ---
        if g.insure_cost:
            color = C_LBLUE if g.insured else C_DGRAY
            frame[INFO_Y0:INFO_Y1, 1:8] = color
            frame[INFO_Y0 + 1:INFO_Y1 - 1, 3:6] = C_WHITE if g.insured else C_BLACK
        if g.turns_max:
            x0 = 10
            width = 63 - x0
            frame[INFO_Y0 + 1:INFO_Y1 - 1, x0:63] = C_VDARK
            left = max(0, min(width, round(width * g.turns_left / g.turns_max)))
            if left:
                low = g.turns_left <= max(3, g.turns_max // 5)
                frame[INFO_Y0 + 1:INFO_Y1 - 1, x0:x0 + left] = C_RED if low else C_LBLUE

        # --- the pile: gems at risk, drawn one by one so the stake is legible ---
        pile_color = C_RED if g.flash else C_YELLOW
        shown = min(g.pile, PILE_COLS * PILE_ROWS)
        for i in range(PILE_COLS * PILE_ROWS):
            cx = 2 + (i % PILE_COLS) * GEM
            cy = PILE_Y0 + (i // PILE_COLS) * GEM
            if i < shown:
                frame[cy:cy + GEM - 1, cx:cx + GEM - 1] = pile_color
                frame[cy + 1:cy + GEM - 2, cx + 1:cx + GEM - 2] = C_WHITE
            else:
                frame[cy + 1:cy + GEM - 2, cx + 1:cx + GEM - 2] = C_VDARK
        # a pile too big for the grid keeps growing as a bar underneath
        if g.pile > PILE_COLS * PILE_ROWS:
            over = min(60, g.pile - PILE_COLS * PILE_ROWS)
            frame[PILE_Y1:PILE_Y1 + 2, 2:2 + over] = pile_color

        # --- urns ---
        n = len(g.urns)
        slot_w = 64 // n
        for i, urn in enumerate(g.urns):
            x0 = i * slot_w + 2
            x1 = x0 + slot_w - 4
            frame[URN_Y0:URN_Y1, x0:x1] = URN_COLORS[i % len(URN_COLORS)]
            frame[URN_Y0, x0:x1] = C_DGRAY
            frame[URN_Y1 - 1, x0:x1] = C_DGRAY

            # which button pushes this urn, as ticks
            for t in range(i + 1):
                tx = x0 + 2 + t * 3
                if tx < x1 - 2:
                    frame[URN_Y0 + 2:URN_Y0 + 6, tx:tx + 2] = C_WHITE

            # hazard meter, on the levels that show it
            if urn.shown:
                my0, my1 = URN_Y0 + 9, URN_Y0 + 14
                frame[my0:my1, x0 + 2:x1 - 2] = C_VDARK
                span = (x1 - 2) - (x0 + 2)
                lit = int(round(span * min(1.0, urn.bust_chance(g.pile))))
                if lit:
                    frame[my0:my1, x0 + 2:x0 + 2 + lit] = C_RED

        return frame


# ============================================================================
# Game
# ============================================================================

class Pl01(ARCBaseGame):
    def __init__(self):
        # Fixed master seed, re-drawn on every level entry: the hazard curves
        # and urn placement are new each time (so nothing can be memorised),
        # but two harness runs meet the identical sequence of luck, which keeps
        # a stochastic game from adding noise to the benchmark score.
        # PL01_SEED re-seeds it, for calibration sweeps only.
        self._master_rng = random.Random(int(os.getenv("PL01_SEED", 0xBADBE7)))
        self._rng = random.Random(0)

        self.display = Pl01Display(self)

        self.urns = []
        self.pile = 0
        self.vault = 0
        self.target = 1
        self.turns_max = self.turns_left = 0
        self.insure_cost = 0
        self.insured = False
        self.ruin = 0
        self.streak_len = None
        self.streak_bonus = 0
        self.streak = 0
        self.bank_fee = 0
        self.flash = 0

        levels = [
            Level(sprites=[], grid_size=(64, 64), data=spec, name=spec["name"])
            for spec in LEVELS
        ]

        super().__init__(
            "pl",
            levels,
            Camera(0, 0, 64, 64, C_BLACK, C_BLACK, [self.display]),
            False,
            len(levels),
            [1, 2, 3, 4],  # push left, push right, bank, insure
        )

    def on_set_level(self, level: Level) -> None:
        spec = LEVELS[self.level_index]
        self._rng = random.Random(self._master_rng.getrandbits(48))

        self.urns = build_urns(spec, self._rng)
        self.pile = 0
        self.vault = 0
        self.target = spec["target"]
        self.turns_max = spec["turns"] or 0
        self.turns_left = self.turns_max
        self.insure_cost = spec["insure"] or 0
        self.insured = False
        self.ruin = spec["ruin"]
        self.streak_len = spec["streak"]
        self.streak_bonus = spec["bonus"]
        self.streak = 0
        self.bank_fee = spec["bank_fee"]
        self.flash = 0

    # -- main loop ---------------------------------------------------------

    def step(self) -> None:
        # A bust holds the pile on screen in red for one frame before clearing
        # it, so the player can actually see what it cost them.
        if self.flash:
            self.flash -= 1
            if not self.flash:
                self.pile = 0
                self._end_turn()
            return

        aid = self.action.id.value

        if aid in (1, 2) and aid - 1 < len(self.urns):
            self._push(self.urns[aid - 1])
            return
        if aid == 3:
            self._bank()
            return
        if aid == 4 and self.insure_cost and not self.insured and self.pile >= self.insure_cost:
            self.pile -= self.insure_cost
            self.insured = True

        self._end_turn()

    def _push(self, urn) -> None:
        chance = urn.bust_chance(self.pile)
        if self.insured:
            self.insured = False
            chance = 0.0

        if self._rng.random() < chance:
            self.streak = 0
            if self.ruin:
                self.vault = max(0, self.vault - self.ruin)
            self.flash = 2          # hold the doomed pile on screen, then clear
            return

        self.pile += urn.reward(self._rng)
        self.streak += 1
        if self.streak_len and self.streak >= self.streak_len:
            self.pile += self.streak_bonus
            self.streak = 0
        self._end_turn()

    def _bank(self) -> None:
        if self.pile:
            self.vault += max(0, self.pile - self.bank_fee)
            self.pile = 0
            self.streak = 0
        self._end_turn()

    def _end_turn(self) -> None:
        if self.turns_max:
            self.turns_left -= 1

        if self.vault >= self.target:
            self.next_level()
            self.complete_action()
            return

        if self.turns_max and self.turns_left <= 0:
            self.lose()

        self.complete_action()
