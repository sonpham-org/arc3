// The decision panel: every LLM call of a turn -- reasoning, the python it ran, what came back.
//
// The raw transcript is a ~38KB wall of text. The backend already splits it into an ordered
// interleave of [THINKING] / [TOOL CALL: python] / [TOOL RESULT: python] / [ASSISTANT] sections,
// so the job here is ordering and triage: lead with what the model did, collapse what it was
// told, and diff the one part of the prompt that actually changes.

import { annotateCoordRefs, MODE } from "./coords.js";

const NOISE = /^(MODEL CONTEXT|MODEL RESPONSE META|PROMPT LOG SNAPSHOT|ACTION_RESPONSE)$/i;
const IS_CODE = /^TOOL CALL/i;
const IS_SYSTEM = /^SYSTEM PROMPT$/i;
const IS_USER = /^USER PROMPT$/i;

export function renderDecision(root, step, { currentClick, previousStep } = {}) {
  root.innerHTML = "";
  if (!step) {
    root.innerHTML = '<div class="empty">No analyzer turn for this frame.</div>';
    return;
  }

  root.appendChild(renderHead(step, currentClick));

  const sections = (step.localContext?.sections || []).filter((s) => !NOISE.test(s.label || ""));
  if (!sections.length) {
    root.insertAdjacentHTML("beforeend", '<div class="empty">No transcript for this turn.</div>');
    return;
  }

  // The transcript IS the conversation, so render it in order: prompt, think, call, result,
  // nag, think, call... Reordering it into buckets destroys the thing a reviewer is reading for.
  const previous = previousStep?.localContext?.sections || [];
  // Each user prompt is diffed against the one before it in the conversation -- which is exactly
  // the delta the model saw. The first of a turn diffs against the previous turn's last, so the
  // chain is unbroken across turn boundaries.
  let priorPrompt = lastContent(previous, "USER PROMPT");

  let call = 0;
  for (const section of sections) {
    if (IS_SYSTEM.test(section.label)) {
      const unchanged = normalize(lastContent(previous, "SYSTEM PROMPT")) === normalize(section.content);
      root.appendChild(renderSection(section, { open: false, note: unchanged ? "unchanged" : "" }));
      continue;
    }
    if (IS_USER.test(section.label)) {
      root.appendChild(renderPrompt(section, priorPrompt));
      priorPrompt = String(section.content || "");
      continue;
    }
    if (IS_CODE.test(section.label)) call += 1;
    root.appendChild(renderSection(section, { open: true, call: IS_CODE.test(section.label) ? call : 0 }));
  }

  root.appendChild(renderRaw(step));
}

function renderHead(step, currentClick) {
  const head = document.createElement("div");
  head.className = "decision-head";

  const title = document.createElement("div");
  title.className = "turn-title";
  title.textContent = step.title || "Turn";
  head.appendChild(title);

  const actions = String(step.actionDisplay || "").split("->").map((a) => a.trim()).filter(Boolean);
  if (actions.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const action of actions) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = action;
      if (currentClick && action.includes(`row=${currentClick.row}`) && action.includes(`col=${currentClick.col}`)) {
        chip.classList.add("current");
      }
      chips.appendChild(chip);
    }
    head.appendChild(chips);
    annotateCoordRefs(chips, MODE.PROSE);
  }

  const bits = [];
  if (step.reward) bits.push(`reward ${step.reward > 0 ? "+" : ""}${step.reward}`);
  bits.push(`score ${step.score ?? 0}`);
  bits.push(`level ${step.level ?? "?"}`);
  if (step.toolCallCount) bits.push(`${step.toolCallCount} tool calls`);
  if (step.attemptCount > 1) bits.push(`${step.attemptCount} attempts`);
  if (step.llm) {
    bits.push(`in ${fmtK(step.llm.promptTokens)} / out ${fmtK(step.llm.completionTokens)}`);
    if (step.llm.errors) bits.push(`${step.llm.errors} errors`);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = bits.join(" · ");
  head.appendChild(meta);

  return head;
}

function renderSection(section, { open, call = 0, note = "" }) {
  const label = section.label || "SECTION";
  const content = section.content || "";
  const details = document.createElement("details");
  details.className = `section kind-${section.kind || "text"}`;
  details.open = open;
  details.appendChild(summaryFor(label, content.length, { call, note }));

  const pre = document.createElement("pre");
  pre.textContent = content;
  details.appendChild(pre);

  const annotate = () => annotateCoordRefs(pre, IS_CODE.test(label) ? MODE.CODE : MODE.PROSE);
  if (open) annotate();
  else details.addEventListener("toggle", () => details.open && annotate(), { once: true });
  return details;
}

/**
 * The user prompt is ~3KB of board state resent every turn. What a reviewer needs is the
 * delta, so highlight the changed lines and let the unchanged bulk collapse away.
 */
function renderPrompt(section, previousContent) {
  const lines = String(section.content || "").split("\n");
  const before = new Set(String(previousContent || "").split("\n"));
  const changed = previousContent ? lines.filter((line) => !before.has(line)).length : lines.length;

  const details = document.createElement("details");
  details.className = "section kind-meta";
  details.appendChild(
    summaryFor(section.label, section.content.length, {
      note: previousContent ? (changed ? `${changed} changed lines` : "unchanged") : "",
    }),
  );

  const render = () => {
    const pre = document.createElement("pre");
    pre.className = "prompt";
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = previousContent && !before.has(line) ? "line changed" : "line";
      row.textContent = line || " ";
      pre.appendChild(row);
    }
    details.appendChild(pre);
    annotateCoordRefs(pre, MODE.PROSE);
  };
  // 3KB of DOM nobody reads until they open it.
  details.addEventListener("toggle", () => details.open && !details.querySelector("pre") && render(), { once: true });
  return details;
}

function renderRaw(step) {
  const sections = step.localContext?.sections || [];
  const raw = sections.map((s) => `[${s.label}]\n${s.content}`).join("\n\n");
  const details = document.createElement("details");
  details.className = "section kind-meta";
  details.appendChild(summaryFor("RAW TRANSCRIPT", raw.length, {}));
  details.addEventListener("toggle", () => {
    if (!details.open || details.querySelector("pre")) return;
    const pre = document.createElement("pre");
    pre.textContent = raw;
    details.appendChild(pre);
  }, { once: true });
  return details;
}

function summaryFor(label, size, { call = 0, note = "" }) {
  const summary = document.createElement("summary");
  const name = call ? `${label} #${call}` : label;
  summary.innerHTML =
    `<span>${escapeHtml(name)}</span><span class="spacer"></span>` +
    (note ? `<span class="note">${escapeHtml(note)}</span>` : "") +
    `<span class="size">${fmtBytes(size)}</span>`;
  return summary;
}

function lastContent(sections, label) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i]?.label === label) return String(sections[i].content || "");
  }
  return "";
}

const normalize = (value) => String(value || "").replaceAll("\r\n", "\n").trimEnd();

function fmtK(value) {
  const n = Number(value || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function fmtBytes(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export { fmtK };
