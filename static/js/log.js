// The event log: one row per action, showing what the model decided and whether it worked.

import { annotateCoordRefs, MODE } from "./coords.js";

export class EventLog {
  constructor(tbody, { onSelect }) {
    this.tbody = tbody;
    this.onSelect = onSelect;
    this.rows = [];
    this.autoScroll = true;

    tbody.addEventListener("click", (event) => {
      // A coord-ref inside the row pins a cell; it must not also move the scrubber.
      if (event.target.closest(".coord-ref")) return;
      const tr = event.target.closest("tr");
      if (tr && tr.dataset.frame !== undefined) this.onSelect(Number(tr.dataset.frame));
    });
  }

  render(frames, steps) {
    // Append-only: a live run adds frames, it never rewrites the ones already drawn.
    if (frames.length < this.rows.length) {
      this.tbody.innerHTML = "";
      this.rows = [];
    }
    const stepByTurn = new Map((steps || []).map((step) => [step.analysisStep, step]));

    for (let i = this.rows.length; i < frames.length; i += 1) {
      const frame = frames[i];
      const step = stepByTurn.get(frame.analysis_step);
      // Only the first action of a turn gets the decision; the rest of the batch replays it.
      const isTurnHead = step !== undefined && frames[i - 1]?.analysis_step !== frame.analysis_step;
      const tr = this.buildRow(frame, step, isTurnHead);
      this.tbody.appendChild(tr);
      this.rows.push(tr);
    }
  }

  buildRow(frame, step, isTurnHead) {
    const tr = document.createElement("tr");
    tr.dataset.frame = String(frame.frameIndex);

    const type = frame.type === "initial" ? "INI" : "ACT";
    // A no-op action is a strong signal the agent is stuck, and nothing surfaced it before.
    const changed = frame.board_changed;
    const delta = frame.type === "action" ? (changed ? "●" : "·") : "";
    const deltaClass = frame.type === "action" && !changed ? "col-d nochange" : "col-d";
    const turn = frame.analysis_step !== undefined ? `T${frame.analysis_step}` : "";

    tr.innerHTML = `
      <td class="col-n">${frame.action_num ?? 0}</td>
      <td class="col-t">${turn}</td>
      <td class="col-ty">${type}</td>
      <td class="${deltaClass}">${delta}</td>
      <td class="col-what"></td>`;

    const what = tr.querySelector(".col-what");
    const action = document.createElement("span");
    action.className = "act";
    action.textContent = frame.action_display || frame.title || "";
    what.appendChild(action);

    if (isTurnHead) {
      tr.classList.add("is-turn");
      if (step.decisionPreview) {
        const code = document.createElement("code");
        code.className = "decision";
        code.textContent = step.decisionPreview;
        what.appendChild(code);
      }
      const bits = [];
      if (step.toolCallCount) bits.push(`${step.toolCallCount} calls`);
      if (step.attemptCount > 1) bits.push(`${step.attemptCount} attempts`);
      if (step.errorCount) bits.push(`${step.errorCount} err`);
      if (bits.length) {
        const meta = document.createElement("span");
        meta.className = step.errorCount ? "llm-meta has-error" : "llm-meta";
        meta.textContent = bits.join(" · ");
        what.appendChild(meta);
      }
    }

    annotateCoordRefs(what, MODE.PROSE);
    return tr;
  }

  select(frameIndex) {
    for (const tr of this.rows) tr.classList.remove("selected");
    const tr = this.rows[frameIndex];
    if (!tr) return;
    tr.classList.add("selected");
    if (this.autoScroll) tr.scrollIntoView({ block: "nearest" });
  }
}
