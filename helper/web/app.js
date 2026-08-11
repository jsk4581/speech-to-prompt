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
  progress: $("#stt-progress"),
  confirmBtn: $("#confirm-btn"),
  cancelBtn: $("#cancel-btn"),
  settingsBtn: $("#settings-btn"),
  enhanceToggle: $("#enhance-toggle"),
  grillToggle: $("#grill-toggle"),
  tabs: $("#xml-tabs"),
  xmlHint: $("#xml-hint"),
  drafting: $("#drafting"),
  draftingQ: $("#drafting-q"),
};

const state = {
  recorder: new Recorder(),
  /** the grill round currently shown (set by SSE 'round'); null = no agent loop yet */
  activeRound: null,
  events: null,
  answerTimer: 0,
  /** sample/mock content is shown until the first Record press wipes it */
  samplesCleared: false,
  /** dual-draft buffers ({default, enhanced}) when an enhance round is active */
  xmlBuffers: null,
  activeTab: "default",
  /** the helper launch this page belongs to (from the SSE 'ready' event) */
  runId: null,
  stale: false,
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
  // With no token (a reload after the fragment was scrubbed) the call rides on
  // that cookie instead — the server accepts either.
  await api("/session", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

// ── SSE push channel ─────────────────────────────────────────────────────────

function connectEvents() {
  const es = new EventSource("/events");
  state.events = es;
  es.addEventListener("ready", (e) => {
    const data = safeJson(e.data);
    // Run-identity guard: after this helper is superseded by a newer launch,
    // this page's EventSource auto-reconnects to the NEW helper. A different
    // run id means this tab no longer owns the session — go inert instead of
    // interfering with the fresh popup.
    if (data.run) {
      if (state.runId && state.runId !== data.run) {
        enterStaleMode();
        return;
      }
      state.runId = data.run;
    }
    if (state.stale) return;
    setStage(data.whisper === "absent" ? "capture · (no model yet)" : "capture");
  });
  es.addEventListener("transcript", (e) => {
    const data = safeJson(e.data);
    if (data.text != null) {
      renderTranscript(data.text);
      showDrafting(); // STT is done — the drafting LLM is working now
    }
  });
  es.addEventListener("transcribe-progress", (e) => {
    const data = safeJson(e.data);
    if (typeof data.pct === "number") setProgress(data.pct);
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
  // download · extract · select · error).
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

// Transcription progress bar (driven by SSE 'transcribe-progress'). Until the
// first real percentage arrives (encode → upload → model load) the bar runs
// indeterminate so the wait never looks dead.
function showProgress() {
  if (!els.progress) return;
  els.progress.removeAttribute("value");
  els.progress.classList.add("indet");
  els.progress.hidden = false;
}
function setProgress(pct) {
  if (!els.progress) return;
  const v = Math.max(0, Math.min(100, pct));
  els.progress.classList.remove("indet");
  els.progress.hidden = false;
  els.progress.value = v;
  setStage(`transcribing… ${Math.round(v)}%`);
}
function hideProgress() {
  if (!els.progress) return;
  els.progress.classList.remove("indet");
  els.progress.hidden = true;
}

// Circular spinners over the XML and questions panes while the drafting LLM
// works (between the transcript landing and the first/next round arriving).
function showDrafting() {
  if (state.stale) return;
  if (els.drafting) els.drafting.hidden = false;
  if (els.draftingQ) els.draftingQ.hidden = false;
}
function hideDrafting() {
  if (els.drafting) els.drafting.hidden = true;
  if (els.draftingQ) els.draftingQ.hidden = true;
}

/** First Record press: wipe the sample content the static View ships with. */
function clearSamples() {
  if (state.samplesCleared) return;
  state.samplesCleared = true;
  renderTranscript("(listening…)");
  if (els.xml) els.xml.textContent = "<!-- your draft appears here after you stop recording -->";
  if (els.questions) els.questions.replaceChildren();
  if (els.qcount) els.qcount.textContent = "0";
  state.xmlBuffers = null;
  showTabs(false);
}

// ── XML tabs (Default | Enhanced — enhance mode only) ───────────────────────

function showTabs(on) {
  if (els.tabs) els.tabs.hidden = !on;
  if (els.xmlHint) els.xmlHint.textContent = on ? "editable · Confirm injects the open tab" : "editable";
  if (!on) return;
  for (const b of els.tabs.querySelectorAll(".tab")) {
    b.classList.toggle("sel", b.dataset.tab === state.activeTab);
  }
}

function selectTab(tab) {
  if (!state.xmlBuffers || tab === state.activeTab || !(tab in state.xmlBuffers)) return;
  // Keep any hand edits: stash the outgoing tab's text before swapping.
  state.xmlBuffers[state.activeTab] = els.xml.textContent ?? "";
  state.activeTab = tab;
  els.xml.textContent = state.xmlBuffers[tab];
  showTabs(true);
}

/**
 * Render a grill round pushed by the agent. Fields are all optional so the agent
 * can send partial updates: { stage?, transcript?, draftXml?, questions? }.
 */
function renderRound(round) {
  state.activeRound = round || {};
  hideDrafting();
  // A new round always re-opens the loop — a prior confirm may have been
  // rejected by the agent, so the button must come back.
  if (els.confirmBtn) els.confirmBtn.disabled = false;
  if (round.problem) {
    setStage("confirm rejected — see note");
    renderTranscript(`⚠ ${round.problem}`);
  } else if (round.stage) {
    setStage(round.stage);
  }
  if (typeof round.transcript === "string") renderTranscript(round.transcript);
  if (typeof round.draftXml === "string") {
    if (typeof round.enhancedXml === "string") {
      // Dual draft: buffer both, land on the Enhanced tab (the one the user
      // opted into); Confirm injects whichever tab is open.
      state.xmlBuffers = { default: round.draftXml, enhanced: round.enhancedXml };
      state.activeTab = "enhanced";
      els.xml.textContent = state.xmlBuffers[state.activeTab];
      showTabs(true);
    } else {
      state.xmlBuffers = null;
      els.xml.textContent = round.draftXml;
      showTabs(false);
    }
  }
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
      clearSamples();
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
    setStage("processing audio…");
    showProgress();
    renderTranscript("(transcribing…)");
    const { blob } = await state.recorder.stop();
    const res = await api("/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: blob,
    });
    const data = await res.json();
    hideProgress();
    renderTranscript(data.text);
    showDrafting();
    setStage(data.language ? `captured · ${data.language} — drafting…` : "captured — drafting…");
  } catch (err) {
    btn.classList.remove("on");
    btn.setAttribute("aria-pressed", "false");
    if (els.recordLabel) els.recordLabel.textContent = "Re-record";
    hideProgress();
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
    postJson("/answer", { answers: collectAnswers() })
      .then(() => {
        // Keep the loop visibly alive: the agent is folding the answers in and
        // will push the next round; nothing here is done silently.
        setStage("answers sent — folding them in…");
        markAnswered();
      })
      .catch(() => setStage("answer failed"));
  }, 250);
}

/** Dim question cards that already carry an answer, so progress is visible. */
function markAnswered() {
  for (const box of els.questions.querySelectorAll(".qbox")) {
    const answered =
      box.querySelector(".chip.sel") || box.querySelector("[data-role=answer]")?.value.trim();
    box.classList.toggle("answered", Boolean(answered));
  }
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

/** Push a draft-setting change. Before a recording it just sets the recipe;
 *  mid-round it is a live control — the agent redrafts, so show the wait. */
function pushSettings(patch) {
  postJson("/mode", patch)
    .then(() => {
      if (state.activeRound) {
        showDrafting();
        setStage("re-drafting with the new settings…");
      }
    })
    .catch(() => setStage("settings change failed"));
}

/** This tab's session was superseded by a newer popup — go fully inert. */
function enterStaleMode() {
  if (state.stale) return;
  state.stale = true;
  state.activeRound = null;
  hideDrafting();
  state.events?.close();
  for (const b of document.querySelectorAll("button, input, textarea, [contenteditable]")) {
    if (b.setAttribute) b.setAttribute("contenteditable", "false");
    b.disabled = true;
  }
  setStage("superseded — a newer STP popup is open; close this tab");
  renderTranscript("This tab belongs to an older run. Use the newest STP popup window.");
}

function cancelSession() {
  postJson("/cancel")
    .then(() => {
      hideDrafting();
      setStage("cancelled — you can close this window");
      state.activeRound = null;
      if (els.confirmBtn) els.confirmBtn.disabled = true;
      if (els.cancelBtn) els.cancelBtn.disabled = true;
    })
    .catch(() => setStage("cancel failed"));
}

function confirmAndInject() {
  const xml = els.xml.textContent ?? "";
  // Delivery ≠ acceptance: the agent validates the confirmed XML and may reject
  // it (unresolved questions, missing success criteria). Only say what we know —
  // "sent" — and let the next SSE round re-open the loop if it was rejected.
  setStage("confirm sent — waiting for validation…");
  els.confirmBtn.disabled = true; // guard double-submit while the POST is in flight
  postJson("/confirm", { xml, answers: collectAnswers() })
    .catch((err) => {
      setStage("confirm failed");
      renderTranscript(`⚠ ${err.message}`);
    })
    .finally(() => {
      els.confirmBtn.disabled = false;
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
      case "xml-tab":
        selectTab(actor.dataset.tab);
        break;
      case "cancel":
        cancelSession();
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

  // Setting switches (footer). Unchecked = the defaults: default mode, grill off.
  els.enhanceToggle?.addEventListener("change", () =>
    pushSettings({ mode: els.enhanceToggle.checked ? "enhance" : "default" }),
  );
  els.grillToggle?.addEventListener("change", () =>
    pushSettings({ grill: els.grillToggle.checked ? "on" : "off" }),
  );

  // Deliberate cancel = the Cancel button only. Popup closure is detected by
  // the helper via SSE disconnect + grace (popup_closed). A pagehide /cancel
  // beacon used to live here, but cookies are origin-wide, so a *stale* popup
  // tab from a superseded run being closed (or tab-discarded, or reloaded)
  // fired it with the new session's cookie — a phantom cancel.
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function main() {
  wireEvents();
  if (els.recordLabel) els.recordLabel.textContent = "Record";
  setStage("connecting…");
  const token = takeLaunchToken();
  try {
    await establishSession(token); // token, or the cookie from a prior visit
    connectEvents();
    // Warm the mic now so the first Record press captures from the first word —
    // the permission prompt and device open happen here, not mid-sentence. A
    // denial is not an error yet; pressing Record retries and surfaces it.
    void state.recorder.prewarm().catch(() => {});
  } catch (err) {
    setStage(token ? "session setup failed" : "no session token — open via the helper");
    renderTranscript(`⚠ ${err.message}`);
  }
}

void main();
