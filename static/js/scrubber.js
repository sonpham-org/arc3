// Frame scrubber: one tick per board state, keyboard driven, with a LIVE/PAUSED feed.

const AUTOPLAY_MS = 250;

export class Scrubber {
  constructor(root, { onSeek }) {
    this.onSeek = onSeek;
    this.frames = [];
    this.pos = 0;
    this.live = true;
    this.ended = false;
    this.timer = null;

    this.slider = root.querySelector("#scrub-slider");
    this.ticks = root.querySelector("#scrub-ticks");
    this.label = root.querySelector("#scrub-label");
    this.dot = root.querySelector("#scrub-dot");
    this.banner = root.querySelector("#scrub-banner");
    this.bannerText = root.querySelector("#scrub-banner-text");

    this.slider.addEventListener("input", () => this.seek(Number(this.slider.value), { user: true }));
    root.querySelector("#scrub-first").addEventListener("click", () => this.seek(0, { user: true }));
    root.querySelector("#scrub-prev").addEventListener("click", () => this.step(-1));
    root.querySelector("#scrub-play").addEventListener("click", () => this.togglePlay());
    root.querySelector("#scrub-next").addEventListener("click", () => this.step(1));
    root.querySelector("#scrub-last").addEventListener("click", () => this.returnToLive());
    root.querySelector("#scrub-return").addEventListener("click", () => this.returnToLive());

    document.addEventListener("keydown", (event) => this.handleKey(event));
  }

  setFrames(frames, { ended }) {
    const wasLive = this.live;
    const grew = frames.length > this.frames.length;
    this.frames = frames;
    this.ended = ended;
    this.slider.max = Math.max(0, frames.length - 1);
    this.renderTicks();

    if (wasLive && grew) this.seek(frames.length - 1, { user: false });
    else this.seek(Math.min(this.pos, Math.max(0, frames.length - 1)), { user: false, silent: !grew });
    this.render();
  }

  renderTicks() {
    const total = this.frames.length;
    if (total < 2) {
      this.ticks.innerHTML = "";
      return;
    }
    // A tick per analyzer turn boundary: shows at a glance where the model stopped to think.
    const marks = [];
    let previousTurn = null;
    this.frames.forEach((frame, index) => {
      const turn = frame.analysis_step ?? null;
      if (turn !== null && turn !== previousTurn) {
        marks.push(`<i style="left:${(index / (total - 1)) * 100}%"></i>`);
        previousTurn = turn;
      }
    });
    this.ticks.innerHTML = marks.join("");
  }

  step(delta) {
    this.seek(this.pos + delta, { user: true });
  }

  seek(pos, { user = false, silent = false } = {}) {
    const clamped = Math.max(0, Math.min(pos, this.frames.length - 1));
    this.pos = clamped;
    this.slider.value = String(clamped);

    if (user) {
      // Dragging to the far right resumes the live feed even when already paused. The old
      // scrubber guarded this with `&& !frozenGrid`, so the one gesture everyone tries -- drag
      // back to the end -- left you stuck in PAUSED.
      this.live = clamped >= this.frames.length - 1;
      if (!this.live) this.stopPlay();
    }

    this.render();
    if (!silent) this.onSeek(clamped);
  }

  returnToLive() {
    this.live = true;
    this.seek(this.frames.length - 1, { user: false });
    this.onSeek(this.pos);
  }

  togglePlay() {
    if (this.timer) return this.stopPlay();
    this.timer = setInterval(() => {
      if (this.pos >= this.frames.length - 1) return this.stopPlay();
      this.seek(this.pos + 1, { user: true });
    }, AUTOPLAY_MS);
    this.render();
  }

  stopPlay() {
    clearInterval(this.timer);
    this.timer = null;
    this.render();
  }

  handleKey(event) {
    if (event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (!this.frames.length) return;

    const jumpTurn = (dir) => {
      const current = this.frames[this.pos]?.analysis_step ?? null;
      const search = dir > 0
        ? this.frames.slice(this.pos + 1).find((f) => (f.analysis_step ?? null) !== current)
        : [...this.frames.slice(0, this.pos)].reverse().find((f) => (f.analysis_step ?? null) !== current);
      if (search) this.seek(search.frameIndex, { user: true });
    };

    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        if (event.shiftKey) jumpTurn(-1);
        else this.step(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (event.shiftKey) jumpTurn(1);
        else this.step(1);
        break;
      case "Home":
        event.preventDefault();
        this.seek(0, { user: true });
        break;
      case "End":
        event.preventDefault();
        this.returnToLive();
        break;
      case " ":
        event.preventDefault();
        this.togglePlay();
        break;
      case "l":
      case "L":
        this.returnToLive();
        break;
      default:
        break;
    }
  }

  render() {
    const total = this.frames.length;
    this.label.textContent = total ? `Frame ${this.pos + 1} / ${total}` : "No frames";
    document.querySelector("#scrub-play").textContent = this.timer ? "❚❚" : "▶";

    if (this.ended) {
      this.dot.className = "live-dot is-ended";
      this.dot.textContent = "● ENDED";
    } else if (this.live) {
      this.dot.className = "live-dot is-live";
      this.dot.textContent = "● LIVE";
    } else {
      this.dot.className = "live-dot is-paused";
      this.dot.textContent = "● PAUSED";
    }

    const showBanner = !this.live && !this.ended;
    this.banner.hidden = !showBanner;
    if (showBanner) {
      const frame = this.frames[this.pos];
      this.bannerText.textContent = `Viewing ${frame?.title || `frame ${this.pos + 1}`} of ${total}`;
    }
  }
}
