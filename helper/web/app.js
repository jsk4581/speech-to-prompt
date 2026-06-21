// STP popup — behavior layer (the View is index.html; this wires it live).
//
// Responsibilities (capture + transport client):
//   - Auth: read the per-run token from the URL fragment (#token=…), trade it
//     for a SameSite=Strict cookie via POST /session, then scrub it from the URL.
//     After that, the EventSource and every POST authenticate by cookie alone —
//     the token never sits in a logged URL or in long-lived JS state.
//   - Push: open EventSource('/events') and react to server events
//     (ready · transcript · round · edit).
//   - Capture: #record-btn → Recorder (record.js) → POST /transcribe → render
//     the text into #transcript live.
//   - Grill plumbing (question content supplied by the agent): when a round is
//     active, answers POST to /answer; Confirm POSTs the edited XML to /confirm;
//     an unload/Cancel POSTs /cancel. The agent long-poll on the helper turns
//     these into the outcome state machine (answered · confirmed · cancelled ·
//     popup_closed).
//
// The hooks (ids / data-action / classes) are the contract from the static View.

import { Recorder } from "./record.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  stage: $("#stage"),
  transcript: $("#transcript"),
  xml: $("#xml-editor"),
  questions: $("#questions"),
  qcount: $("#q-count"),
  recordBtn: $("#record-btn"),
  recordLabel: $("[data-role=record-label]"),
  confirmBtn: $("#confirm-btn"),
  settingsBtn: $("#settings-btn"),
};

const state = {
  recorder: new Recorder(),
  /** the grill round currently shown (set by SSE 'round'); null = no agent loop yet */
  activeRound: null,
  events: null,
  answerTimer: 0,
};

// ── helpers ──────────────────────────────────────────────────────────────────

function setStage(text) {
  if (els.stage) els.stage.textContent = `· ${text}`;
}

/** Same-origin fetch; auth rides on the SameSite cookie set at /session. */
async function api(path, { method = "GET", body, headers } = {}) {
  const res = await fetch(path, {
    method,
    headers,
    body,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status} ${detail}`.trim());
  }
  return res;
}

const postJson = (path, obj) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj ?? {}),
  });

// ── token fragment → cookie exchange ─────────────────────────────────────────

/** Pull the launch token from the fragment (#token=) or, as a fallback, ?t=. */
function takeLaunchToken() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const fromHash = new URLSearchParams(hash).get("token");
  const fromQuery = new URLSearchParams(location.search).get("t");
  const token = fromHash ?? fromQuery ?? "";
  // Scrub it from the address bar so it doesn't linger in history.
  if (token) history.replaceState(null, "", location.pathname);
  return token;
}

async function establishSession(token) {
  // The first call carries the token as a Bearer header; the response sets the
  // SameSite=Strict cookie that authenticates the SSE stream + later POSTs.
  await api("/session", { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

// ── SSE push channel ─────────────────────────────────────────────────────────

function connectEvents() {
  const es = new EventSource("/events");
  state.events = es;
  es.addEventListener("ready", (e) => {
    const data = safeJson(e.data);
    setStage(data.whisper === "absent" ? "capture · (no model yet)" : "capture");
  });
  es.addEventListener("transcript", (e) => {
    const data = safeJson(e.data);
    if (data.text != null) renderTranscript(data.text);
  });
  es.addEventListener("round", (e) => {
    renderRound(safeJson(e.data));
  });
  es.addEventListener("edit", (e) => {
    const data = safeJson(e.data);
    if (typeof data.xml === "string") els.xml.textContent = data.xml;
  });
  // First-run model bootstrap progress; the helper pushes these while a
  // model is still downloading. Phase names come from the bootstrap (check ·
  // download · extract · bench · select · error).
  es.addEventListener("bootstrap", (e) => {
    const p = safeJson(e.data);
    if (p.phase === "select" || p.phase === "done") {
      setStage("capture");
      return;
    }
    const pct = typeof p.pct === "number" ? ` ${Math.round(p.pct)}%` : "";
    setStage(`preparing model · ${p.phase || "…"}${pct}`);
  });
  es.onerror = () => setStage("reconnecting…"); // EventSource auto-retries
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderTranscript(text) {
  els.transcript.textContent = text || "(nothing captured)";
}

/**
 * Render a grill round pushed by the agent. Fields are all optional so the agent
 * can send partial updates: { stage?, transcript?, draftXml?, questions? }.
 */
function renderRound(round) {
  state.activeRound = round || {};
  if (round.stage) setStage(round.stage);
  if (typeof round.transcript === "string") renderTranscript(round.transcript);
  if (typeof round.draftXml === "string") els.xml.textContent = round.draftXml;
  if (Array.isArray(round.questions)) renderQuestions(round.questions);
}

function renderQuestions(questions) {
  els.questions.replaceChildren();
  questions.forEach((q, i) => els.questions.append(questionBox(q, i + 1)));
  if (els.qcount) els.qcount.textContent = String(questions.length);
}

/** Build one question card matching the static View's markup/classes. */
function questionBox(q, n) {
  const box = document.createElement("div");
  box.className = "qbox";
  box.dataset.q = String(q.id ?? n);

  const top = document.createElement("div");
  top.className = "qtop";
  top.append(
    spanWith("qmark", "?"),
    spanWith("qnum", `Q${n}`),
    spanWith("qtag", q.tag ?? ""),
  );

  const text = document.createElement("div");
  text.className = "qtext";
  text.textContent = q.text ?? "";

  box.append(top, text);

  if (Array.isArray(q.chips) && q.chips.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const label of q.chips) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.action = "chip";
      chip.setAttribute("aria-pressed", "false");
      chip.textContent = label;
      chips.append(chip);
    }
    box.append(chips);
  }

  const ans = document.createElement("textarea");
  ans.className = "ans";
  ans.rows = 1;
  ans.dataset.role = "answer";
  ans.placeholder = "or answer directly…";
  box.append(ans);

  return box;
}

function spanWith(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

// ── capture: record → transcribe → display ───────────────────────────────────

async function toggleRecord() {
  const btn = els.recordBtn;
  try {
    if (!state.recorder.recording) {
      await state.recorder.start();
      btn.classList.add("on");
      btn.setAttribute("aria-pressed", "true");
      if (els.recordLabel) els.recordLabel.textContent = "Stop";
      setStage("recording…");
      return;
    }
    // stop → encode → upload → transcribe
    btn.classList.remove("on");
    btn.setAttribute("aria-pressed", "false");
    if (els.recordLabel) els.recordLabel.textContent = "Re-record";
    setStage("transcribing…");
    const { blob } = await state.recorder.stop();
    const res = await api("/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: blob,
    });
    const data = await res.json();
    renderTranscript(data.text);
    setStage(data.language ? `captured · ${data.language}` : "captured");
  } catch (err) {
    btn.classList.remove("on");
    btn.setAttribute("aria-pressed", "false");
    if (els.recordLabel) els.recordLabel.textContent = "Re-record";
    setStage("mic/transcribe error");
    renderTranscript(`⚠ ${err.message}`);
  }
}

// ── grill answers / confirm / cancel (the question loop) ─────────────────────

/** Collect the current answers from every question card. */
function collectAnswers() {
  const out = [];
  for (const box of els.questions.querySelectorAll(".qbox")) {
    const chosen = box.querySelector(".chip.sel");
    const typed = box.querySelector("[data-role=answer]")?.value.trim();
    out.push({
      id: box.dataset.q,
      choice: chosen ? chosen.textContent : null,
      text: typed || null,
    });
  }
  return out;
}

/** Send answers back to the agent — only while a real round is active. */
function pushAnswers() {
  if (!state.activeRound) return; // sample questions in the default View are local
  clearTimeout(state.answerTimer);
  state.answerTimer = setTimeout(() => {
    postJson("/answer", { answers: collectAnswers() }).catch(() => setStage("answer failed"));
  }, 250);
}

function onChipClick(chip) {
  // single-select within a question card
  const group = chip.closest(".chips");
  if (group) {
    for (const c of group.querySelectorAll(".chip")) {
      const on = c === chip;
      c.classList.toggle("sel", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  pushAnswers();
}

function confirmAndInject() {
  const xml = els.xml.textContent ?? "";
  setStage("confirming…");
  postJson("/confirm", { xml, answers: collectAnswers() })
    .then(() => {
      state.activeRound = null;
      setStage("confirmed → injected");
      els.confirmBtn.disabled = true;
    })
    .catch((err) => {
      setStage("confirm failed");
      renderTranscript(`⚠ ${err.message}`);
    });
}

// ── wiring ───────────────────────────────────────────────────────────────────

function wireEvents() {
  // Delegated click handling keyed off data-action (survives re-rendered rounds).
  document.addEventListener("click", (e) => {
    const actor = e.target.closest("[data-action]");
    if (!actor) return;
    switch (actor.dataset.action) {
      case "record":
        void toggleRecord();
        break;
      case "chip":
        onChipClick(actor);
        break;
      case "confirm":
        confirmAndInject();
        break;
      case "open-settings":
        setStage("settings · provider/BYOK (coming soon)");
        break;
    }
  });

  // Typed answers also flow back to the agent (debounced) while a round is active.
  document.addEventListener("input", (e) => {
    if (e.target.matches?.("[data-role=answer]")) pushAnswers();
  });

  // Leaving the popup mid-grill = cancel (best-effort; SSE close is the backstop).
  window.addEventListener("pagehide", () => {
    if (state.activeRound) {
      try {
        navigator.sendBeacon?.("/cancel");
      } catch {
        /* SSE disconnect → helper declares popup_closed after grace */
      }
    }
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function main() {
  wireEvents();
  if (els.recordLabel) els.recordLabel.textContent = "Record";
  setStage("connecting…");
  const token = takeLaunchToken();
  if (!token) {
    setStage("no session token — open via the helper");
    return;
  }
  try {
    await establishSession(token);
    connectEvents();
  } catch (err) {
    setStage("session setup failed");
    renderTranscript(`⚠ ${err.message}`);
  }
}

void main();
