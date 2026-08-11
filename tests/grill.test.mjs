// Unit tests for the grill bridge's pure logic (helper/src/grill.ts).
//
// Run the compiled output (same as xml.test.mjs):
//   cd helper && npm run build && node --test ../tests/
//
// These cover the bridge's glue: the GrillDraft → popup-round transform
// (including the choices→chips rename the View expects), the confirm-time
// validation gate, and transcript.jsonl tailing. Zero third-party deps.

import { test } from "node:test";
import assert from "node:assert/strict";

import { roundPayload, finalizeConfirmed, latestTranscript } from "../helper/dist/grill.js";

// ── roundPayload ─────────────────────────────────────────────────────────────

test("roundPayload renames question.choices to the popup's chips", () => {
  const draft = {
    sections: [{ name: "objective", attrs: { mode: "?" }, segments: [{ text: "do it", source: "said" }] }],
    questions: [
      { id: "q1", tag: "Implement vs. advise", text: "Implement or advise?", choices: ["Implement", "Advise"], resolves: "objective" },
    ],
  };
  const p = roundPayload(draft);
  assert.equal(p.questions.length, 1);
  assert.deepEqual(p.questions[0].chips, ["Implement", "Advise"]);
  assert.equal(p.questions[0].id, "q1");
  assert.equal(p.questions[0].tag, "Implement vs. advise");
});

test("roundPayload generates the draft XML and a question count stage", () => {
  const draft = {
    sections: [
      { name: "objective", attrs: { mode: "implement" }, segments: [{ text: "Add OAuth", source: "said" }] },
    ],
    questions: [{ id: "q1", tag: "t", text: "one?" }],
  };
  const p = roundPayload(draft);
  assert.match(p.draftXml, /^<task>/);
  assert.match(p.draftXml, /<objective mode="implement">/);
  assert.match(p.stage, /1 question\b/);
});

test("roundPayload handles a draft with no questions", () => {
  const p = roundPayload({ sections: [], questions: [] });
  assert.deepEqual(p.questions, []);
  assert.match(p.stage, /0 questions/);
  // A question with no choices yields an empty chips array (not undefined).
  const p2 = roundPayload({ sections: [], questions: [{ id: "q1", tag: "t", text: "x" }] });
  assert.deepEqual(p2.questions[0].chips, []);
});

test("roundPayload renders the enhanced variant when present", () => {
  const draft = {
    sections: [{ name: "context", segments: [{ text: "just my words", source: "said" }] }],
    enhanced: [
      { name: "context", segments: [{ text: "just my words", source: "said" }] },
      { name: "references", segments: [{ text: "src/a.ts", source: "inferred" }] },
    ],
    questions: [],
  };
  const p = roundPayload(draft);
  assert.match(p.draftXml, /just my words/);
  assert.ok(!p.draftXml.includes("<references>"), "default draft stays faithful");
  assert.match(p.enhancedXml, /<references>/);
});

test("roundPayload omits enhancedXml when the draft has no enhanced variant", () => {
  const p = roundPayload({ sections: [], questions: [] });
  assert.equal(p.enhancedXml, undefined);
});

test("roundPayload passes the draft's settings echo through", () => {
  const p = roundPayload({ sections: [], questions: [], settings: { mode: "enhance", grill: "on" } });
  assert.deepEqual(p.settings, { mode: "enhance", grill: "on" });
  assert.equal(roundPayload({ sections: [], questions: [] }).settings, undefined);
});

// ── finalizeConfirmed ────────────────────────────────────────────────────────

const READY_XML = `<task>
  <objective mode="implement">
    Add Google OAuth to the login page.
  </objective>
  <success_criteria>
    Google login issues a session cookie; the login e2e passes.
  </success_criteria>
</task>`;

test("finalizeConfirmed accepts an injection-ready document and normalizes it", () => {
  const r = finalizeConfirmed(READY_XML);
  assert.equal(r.ok, true);
  assert.match(r.xml, /<objective mode="implement">/);
  assert.match(r.xml, /<success_criteria>/);
  // Re-running on the normalized output is stable.
  const again = finalizeConfirmed(r.xml);
  assert.equal(again.ok, true);
});

test("finalizeConfirmed accepts a bare dictation document (no gate-required fields)", () => {
  const r = finalizeConfirmed(`<task><context>tidy these words up</context></task>`);
  assert.equal(r.ok, true);
  assert.match(r.xml, /<context>/);
});

test("finalizeConfirmed strips an unresolved '?' objective mode instead of rejecting", () => {
  const r = finalizeConfirmed(`<task><objective mode="?">do the thing</objective></task>`);
  assert.equal(r.ok, true);
  assert.ok(r.xml.includes("<objective>"), r.xml);
  assert.ok(!r.xml.includes('mode="?"'), r.xml);
});

test("finalizeConfirmed rejects a stated but invalid objective mode", () => {
  const r = finalizeConfirmed(`<task><objective mode="ponder">x</objective></task>`);
  assert.equal(r.ok, false);
  assert.match(r.problem, /invalid/);
});

test("finalizeConfirmed rejects all-caps emphasis (generator invariant)", () => {
  const r = finalizeConfirmed(
    `<task><objective mode="implement">This is CRITICAL work</objective></task>`,
  );
  assert.equal(r.ok, false);
  assert.match(r.problem, /CRITICAL/);
});

test("finalizeConfirmed reports a parse failure when there is no <task> root", () => {
  const r = finalizeConfirmed("just some text, not xml");
  assert.equal(r.ok, false);
  assert.match(r.problem, /task/i);
});

// ── latestTranscript ─────────────────────────────────────────────────────────

test("latestTranscript returns the last usable line's text", () => {
  const jsonl = `{"text":"first","language":"en"}\n{"text":"second","language":"ko"}\n`;
  assert.deepEqual(latestTranscript(jsonl), { text: "second", language: "ko", mode: undefined, grill: undefined });
});

test("latestTranscript passes the draft mode through (and drops junk values)", () => {
  assert.equal(latestTranscript(`{"text":"t","mode":"default"}`).mode, "default");
  assert.equal(latestTranscript(`{"text":"t","mode":"enhance"}`).mode, "enhance");
  assert.equal(latestTranscript(`{"text":"t","mode":"max"}`).mode, undefined);
});

test("latestTranscript passes the grill setting through (and drops junk values)", () => {
  assert.equal(latestTranscript(`{"text":"t","grill":"off"}`).grill, "off");
  assert.equal(latestTranscript(`{"text":"t","grill":"on"}`).grill, "on");
  assert.equal(latestTranscript(`{"text":"t","grill":"maybe"}`).grill, undefined);
});

test("latestTranscript skips malformed and empty-text lines", () => {
  assert.deepEqual(latestTranscript(`{"text":"real"}\nnot json`), { text: "real", language: undefined, mode: undefined, grill: undefined });
  assert.deepEqual(latestTranscript(`{"text":"keep"}\n{"text":"   "}`), { text: "keep", language: undefined, mode: undefined, grill: undefined });
});

test("latestTranscript returns null when there is nothing usable", () => {
  assert.equal(latestTranscript(""), null);
  assert.equal(latestTranscript("\n\n"), null);
});
