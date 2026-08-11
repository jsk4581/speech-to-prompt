// Unit tests for the coding-prompt XML schema, generator, and parser.
//
// Plain ESM + Node's built-in test runner (zero deps). They import the COMPILED
// helper output, so build first:
//
//   cd helper && npm run build && node --test ../tests/
//
// or from the repo root: `node --test tests/` after `helper` is built.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SECTION_ORDER,
  escapeXml,
  escapeAttr,
  unescapeXml,
  sectionText,
  getSection,
  lintDraft,
  assertInjectable,
  generateXml,
  parseXml,
} from "../helper/dist/xml.js";

// ── builders ────────────────────────────────────────────────────────────────

const seg = (text, source = "said") => ({ text, source });

/** A complete, injection-ready draft. */
function injectableDraft() {
  return {
    lang: "en",
    sections: [
      { name: "context", segments: [seg("Add Google OAuth to the login page.")] },
      { name: "references", segments: [seg("src/pages/login.tsx:18, src/auth/", "inferred")] },
      { name: "objective", attrs: { mode: "implement" }, segments: [seg("Wire Google OAuth end to end.")] },
      { name: "success_criteria", segments: [seg("Login e2e passes; verify by running the suite.", "inferred")] },
      { name: "guardrails", segments: [seg("Reuse the existing auth flow; no hardcoded secrets.", "inferred")] },
    ],
    questions: [],
  };
}

// ── escaping ──────────────────────────────────────────────────────────────

test("escapeXml escapes ampersand first, then angle brackets", () => {
  assert.equal(escapeXml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
});

test("escapeAttr also escapes the double quote", () => {
  assert.equal(escapeAttr('say "hi" <x>'), "say &quot;hi&quot; &lt;x&gt;");
});

test("unescapeXml decodes named and numeric entities in one pass", () => {
  assert.equal(unescapeXml("a &lt; b &amp; c &#39;q&#39; &#x27;r&#x27;"), "a < b & c 'q' 'r'");
});

test("escape -> unescape round-trips arbitrary text", () => {
  const s = `tricky <tag attr="v"> & 'quotes' & ampersands &amp; done`;
  assert.equal(unescapeXml(escapeXml(s)), s);
});

// ── generate ────────────────────────────────────────────────────────────────

test("generateXml emits a closed <task> root (no dangling prefill)", () => {
  const xml = generateXml(injectableDraft());
  assert.ok(xml.startsWith("<task>"));
  assert.ok(xml.trimEnd().endsWith("</task>"));
});

test("generateXml reorders sections so references lands near the top", () => {
  const draft = {
    sections: [
      { name: "objective", attrs: { mode: "advise" }, segments: [seg("Do the thing")] },
      { name: "references", segments: [seg("src/a.ts", "inferred")] },
      { name: "context", segments: [seg("The login page needs OAuth")] },
    ],
    questions: [],
  };
  const xml = generateXml(draft);
  const iCtx = xml.indexOf("<context>");
  const iRefs = xml.indexOf("<references>");
  const iObj = xml.indexOf("<objective");
  assert.ok(iCtx < iRefs && iRefs < iObj, `expected context < references < objective, got ${iCtx},${iRefs},${iObj}`);
});

test("generateXml writes the objective mode attribute", () => {
  const xml = generateXml(injectableDraft());
  assert.match(xml, /<objective mode="implement">/);
});

test("generateXml drops empty sections but keeps objective", () => {
  const draft = {
    sections: [
      { name: "context", segments: [] },
      { name: "objective", attrs: { mode: "advise" }, segments: [] },
    ],
    questions: [],
  };
  const xml = generateXml(draft);
  assert.ok(!xml.includes("<context>"), "empty context should be dropped");
  assert.match(xml, /<objective mode="advise">/);
});

test("generateXml escapes content", () => {
  const draft = {
    sections: [
      { name: "objective", attrs: { mode: "implement" }, segments: [seg("handle a < b && flush")] },
      { name: "success_criteria", segments: [seg("ok")] },
    ],
    questions: [],
  };
  const xml = generateXml(draft);
  assert.ok(xml.includes("a &lt; b &amp;&amp; flush"));
});

test("generateXml({injectionReady}) throws on an unresolved draft", () => {
  const draft = injectableDraft();
  getSection(draft, "objective").attrs.mode = "?";
  assert.throws(() => generateXml(draft, { injectionReady: true }), /not injection-ready/);
});

test("generateXml({injectionReady}) passes on a ready draft", () => {
  assert.doesNotThrow(() => generateXml(injectableDraft(), { injectionReady: true }));
});

// ── lint (baked-in invariants) ──────────────────────────────────────────────

test("lintDraft flags all-caps emphasis as an error", () => {
  const draft = injectableDraft();
  getSection(draft, "context").segments = [seg("This is CRITICAL and you MUST do it")];
  const errs = lintDraft(draft).filter((v) => v.rule === "no-emphasis");
  assert.ok(errs.length >= 2, `expected CRITICAL and MUST flagged, got ${errs.length}`);
  assert.ok(errs.every((v) => v.severity === "error"));
});

test("lintDraft leaves acronyms alone", () => {
  const draft = injectableDraft();
  getSection(draft, "context").segments = [seg("Use the OAuth API over HTTP and return XML/JSON")];
  const errs = lintDraft(draft).filter((v) => v.rule === "no-emphasis");
  assert.equal(errs.length, 0, JSON.stringify(errs));
});

test('lintDraft flags "DO NOT" emphasis', () => {
  const draft = injectableDraft();
  getSection(draft, "context").segments = [seg("DO NOT skip the tests")];
  assert.ok(lintDraft(draft).some((v) => v.rule === "no-emphasis"));
});

test("lintDraft warns on negative phrasing in steps, but not in guardrails", () => {
  const draft = injectableDraft();
  draft.sections.push({ name: "steps", segments: [seg("Do not call the legacy endpoint")] });
  const v = lintDraft(draft);
  assert.ok(v.some((x) => x.rule === "prefer-positive" && x.where === "steps"));
  // guardrails legitimately say "no hardcoded secrets" — no positive-phrasing warning there
  assert.ok(!v.some((x) => x.rule === "prefer-positive" && x.where === "guardrails"));
});

test("lintDraft warns when references sits after objective", () => {
  const draft = {
    sections: [
      { name: "objective", attrs: { mode: "advise" }, segments: [seg("x")] },
      { name: "references", segments: [seg("src/a.ts", "inferred")] },
    ],
    questions: [],
  };
  assert.ok(lintDraft(draft).some((v) => v.rule === "references-at-top" && v.severity === "warn"));
});

// ── assertInjectable ────────────────────────────────────────────────────────

test("assertInjectable accepts a ready draft", () => {
  assert.doesNotThrow(() => assertInjectable(injectableDraft()));
});

test("assertInjectable rejects an open question slot", () => {
  const draft = injectableDraft();
  getSection(draft, "objective").segments = [{ text: "tbd", source: "question", questionId: "q1" }];
  assert.throws(() => assertInjectable(draft), /open question/);
});

test("assertInjectable rejects an unresolved objective mode", () => {
  const draft = injectableDraft();
  getSection(draft, "objective").attrs.mode = "?";
  assert.throws(() => assertInjectable(draft), /objective mode/);
});

test("assertInjectable rejects an invalid objective mode", () => {
  const draft = injectableDraft();
  getSection(draft, "objective").attrs.mode = "ponder";
  assert.throws(() => assertInjectable(draft), /objective mode/);
});

test("assertInjectable requires success_criteria", () => {
  const draft = injectableDraft();
  draft.sections = draft.sections.filter((s) => s.name !== "success_criteria");
  assert.throws(() => assertInjectable(draft), /success_criteria/);
});

// ── parse (tolerant) ────────────────────────────────────────────────────────

test("parseXml throws when there is no <task> root", () => {
  assert.throws(() => parseXml("<context>hi</context>"), /no <task>/);
});

test("parseXml reads sections, text, and the objective mode", () => {
  const draft = parseXml(
    `<task>
       <context>The login page needs OAuth</context>
       <objective mode="implement">Wire OAuth</objective>
       <success_criteria>e2e passes</success_criteria>
     </task>`,
  );
  assert.equal(sectionText(getSection(draft, "context")), "The login page needs OAuth");
  assert.equal(getSection(draft, "objective").attrs.mode, "implement");
  assert.equal(sectionText(getSection(draft, "success_criteria")), "e2e passes");
});

test("parseXml tolerates comments, CRLF, entities, and single-quoted attrs", () => {
  const xml =
    "<!-- drafted by STP -->\r\n<task>\r\n" +
    "  <objective mode='advise'>handle a &lt; b &amp; c</objective>\r\n" +
    "  <references>src/x.ts</references>\r\n" +
    "</task>";
  const draft = parseXml(xml);
  assert.equal(getSection(draft, "objective").attrs.mode, "advise");
  assert.equal(sectionText(getSection(draft, "objective")), "handle a < b & c");
  assert.ok(getSection(draft, "references"));
});

test("parseXml ignores unknown tags (including the retired <role>)", () => {
  const draft = parseXml(`<task><context>x</context><role>legacy</role><made_up>ignored</made_up></task>`);
  assert.ok(getSection(draft, "context"));
  assert.equal(draft.sections.length, 1);
});

test("parseXml preserves document order (for ordering lint)", () => {
  const draft = parseXml(`<task><objective mode="advise">a</objective><references>r</references></task>`);
  assert.deepEqual(
    draft.sections.map((s) => s.name),
    ["objective", "references"],
  );
});

// ── round-trip ──────────────────────────────────────────────────────────────

test("generate -> parse preserves names (canonical order), text, and mode", () => {
  const draft = injectableDraft();
  const reparsed = parseXml(generateXml(draft));

  // names come back in canonical SECTION_ORDER
  const names = reparsed.sections.map((s) => s.name);
  const expected = SECTION_ORDER.filter((n) => names.includes(n));
  assert.deepEqual(names, expected);

  for (const original of draft.sections) {
    const back = getSection(reparsed, original.name);
    assert.ok(back, `missing ${original.name} after round-trip`);
    assert.equal(sectionText(back).trim(), sectionText(original).trim());
  }
  assert.equal(getSection(reparsed, "objective").attrs.mode, "implement");
});

test("parsed (reordered) XML stays injectable after generate normalizes order", () => {
  // user moved references below objective; regenerate fixes it and it injects clean
  const draft = parseXml(
    `<task>
       <objective mode="implement">go</objective>
       <references>src/a.ts</references>
       <success_criteria>tests pass</success_criteria>
     </task>`,
  );
  const xml = generateXml(draft, { injectionReady: true });
  assert.ok(xml.indexOf("<references>") < xml.indexOf("<objective"));
});
