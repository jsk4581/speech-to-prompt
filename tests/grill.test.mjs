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

test("finalizeConfirmed rejects a missing success_criteria", () => {
  const r = finalizeConfirmed(`<task><objective mode="implement">x</objective></task>`);
  assert.equal(r.ok, false);
  assert.match(r.problem, /success_criteria/);
});

test("finalizeConfirmed rejects an unresolved objective mode", () => {
  const r = finalizeConfirmed(
    `<task><objective mode="?">x</objective><success_criteria>y</success_criteria></task>`,
  );
  assert.equal(r.ok, false);
  assert.match(r.problem, /mode/);
});

test("finalizeConfirmed rejects all-caps emphasis (generator invariant)", () => {
  const r = finalizeConfirmed(
    `<task><objective mode="implement">This is CRITICAL work</objective><success_criteria>y</success_criteria></task>`,
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
  assert.deepEqual(latestTranscript(jsonl), { text: "second", language: "ko", mode: undefined });
});

test("latestTranscript passes the draft mode through (and drops junk values)", () => {
  assert.equal(latestTranscript(`{"text":"t","mode":"simple"}`).mode, "simple");
  assert.equal(latestTranscript(`{"text":"t","mode":"max"}`).mode, "max");
  assert.equal(latestTranscript(`{"text":"t","mode":"bogus"}`).mode, undefined);
});

test("latestTranscript skips malformed and empty-text lines", () => {
  assert.deepEqual(latestTranscript(`{"text":"real"}\nnot json`), { text: "real", language: undefined, mode: undefined });
  assert.deepEqual(latestTranscript(`{"text":"keep"}\n{"text":"   "}`), { text: "keep", language: undefined, mode: undefined });
});

test("latestTranscript returns null when there is nothing usable", () => {
  assert.equal(latestTranscript(""), null);
  assert.equal(latestTranscript("\n\n"), null);
});
