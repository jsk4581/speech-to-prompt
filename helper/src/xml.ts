// STP — coding-prompt XML: schema, generator, and a tolerant parser.
//
// This is the "output contract" of the grill: a rough spoken intent is compiled
// into ONE structured <task> document that goes straight to a coding agent.
//
// Two representations, on purpose:
//   1. GrillDraft  — the structured working model. Every piece of content carries
//      a provenance ("said" by the user, "inferred"/proposed by STP, or an open
//      "question" slot). The popup paints this (mint = proposal, gold = question).
//   2. The injected XML — what the coding agent actually receives. It is clean:
//      provenance is a draft-time concern and never leaks into the prompt.
//
// generateXml(draft)  : GrillDraft -> clean XML (canonical section order).
// parseXml(xml)       : XML text  -> GrillDraft (tolerant; for re-ingesting an
//                       LLM draft or validating user edits before injection).
//
// Generator invariants are baked in (see lintDraft / assertInjectable): no
// all-caps emphasis ("CRITICAL"/"MUST"/…) that over-triggers the model, prefer
// positive phrasing, reference material near the top, and a closed <task> root
// (no dangling prefill). No third-party deps — pure string logic.

/** Where a piece of draft content came from. Drives the popup's highlighting. */
export type Source = "said" | "inferred" | "question";

/** The 9-section coding-prompt skeleton (Claude prompting best-practices). */
export type SectionName =
  | "context" // 1. the why / motivation
  | "references" // 2. repo files & material — kept near the top
  | "objective" // 3. explicit goal; mode = implement vs. advise
  | "steps" // 4. ordered instructions
  | "examples" // 5. concrete examples
  | "guardrails" // 6. what to avoid (over-engineering, hardcoding, …)
  | "success_criteria" // 7. definition of done + how to self-verify
  | "output" // 8. how to report back
  | "ambiguity"; // 9. escape hatch: ask when a requirement is unclear

/** Canonical emit order. The generator always reorders to this. */
export const SECTION_ORDER: readonly SectionName[] = [
  "context",
  "references",
  "objective",
  "steps",
  "examples",
  "guardrails",
  "success_criteria",
  "output",
  "ambiguity",
];

/** Resolved values for <objective mode>. "?" means still an open question. */
export const OBJECTIVE_MODES = ["implement", "advise"] as const;
export type ObjectiveMode = (typeof OBJECTIVE_MODES)[number];

/**
 * All-caps emphasis words that over-trigger the model (a generator invariant).
 * Matched as whole ALL-CAPS words only, so acronyms (XML, API, OAuth, HTTP) pass.
 */
export const BANNED_EMPHASIS = [
  "CRITICAL",
  "IMPORTANT",
  "MUST",
  "NEVER",
  "ALWAYS",
  "MANDATORY",
  "REQUIRED",
  "URGENT",
  "CAUTION",
  "WARNING",
  "DANGER",
  "SHALL",
] as const;

/** One inline span of section content with its provenance. */
export interface Segment {
  text: string;
  source: Source;
  /** When source === "question", the id of the open question this slot resolves. */
  questionId?: string;
}

/** One section of the <task> document. */
export interface Section {
  name: SectionName;
  segments: Segment[];
  /** Tag attributes, e.g. { mode: "implement" } on <objective>. */
  attrs?: Record<string, string>;
}

/**
 * A grill question for the popup's third column. NOT part of the injected XML —
 * it travels alongside the draft (sidecar), because subagents cannot ask the
 * user directly (subagents run autonomously): they only produce the question text.
 */
export interface Question {
  /** Stable id, e.g. "q1"; a "question" segment references it via questionId. */
  id: string;
  /** Short category label, e.g. "Implement vs. advise", "Scope · files". */
  tag: string;
  /** The question prose, in the user's language. */
  text: string;
  /** Optional quick-reply chips; the user may also answer freely. */
  choices?: string[];
  /** The section this question resolves, if any (e.g. "objective"). */
  resolves?: SectionName;
}

/** The structured working model produced by the grill subagent. */
export interface GrillDraft {
  /** BCP-47-ish language of the prose, e.g. "ko" | "en". */
  lang?: string;
  /** Sections in any order; the generator emits them in SECTION_ORDER. */
  sections: Section[];
  /** Open questions for the popup (sidecar; not serialized into the XML). */
  questions: Question[];
}

export type Severity = "error" | "warn";

/** A single lint finding against the generator invariants. */
export interface Violation {
  rule:
    | "no-emphasis"
    | "prefer-positive"
    | "references-at-top"
    | "open-question"
    | "objective-mode"
    | "missing-success-criteria"
    | "missing-objective";
  severity: Severity;
  message: string;
  /** The section the finding applies to, when relevant. */
  where?: SectionName;
}

// ── escaping ──────────────────────────────────────────────────────────────

/** Escape text content for XML (& first, then angle brackets). */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value (text rules plus the double quote). */
export function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, "&quot;");
}

/**
 * Decode XML entities — named (&lt; &gt; &amp; &quot; &apos;) and numeric
 * (&#39; / &#x27;). One pass, so there is no double-decoding hazard.
 */
export function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const isHex = ent[1] === "x" || ent[1] === "X";
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    return named[ent.toLowerCase()] ?? whole;
  });
}

// ── small accessors ─────────────────────────────────────────────────────────

/** The plain text of a section (all segments concatenated). */
export function sectionText(section: Section): string {
  return section.segments.map((s) => s.text).join("");
}

/** First section with the given name, or undefined. */
export function getSection(draft: GrillDraft, name: SectionName): Section | undefined {
  return draft.sections.find((s) => s.name === name);
}

// ── lint (the baked-in invariants) ──────────────────────────────────────────

/** Flag all-caps emphasis words that over-trigger the model. */
function lintEmphasis(text: string, where: SectionName): Violation[] {
  const out: Violation[] = [];
  for (const word of BANNED_EMPHASIS) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      out.push({
        rule: "no-emphasis",
        severity: "error",
        where,
        message: `${where}: drop all-caps emphasis "${word}" — it over-triggers the model; phrase it plainly`,
      });
    }
  }
  if (/\bDO NOT\b/.test(text)) {
    out.push({
      rule: "no-emphasis",
      severity: "error",
      where,
      message: `${where}: drop "DO NOT" emphasis — state the desired behavior instead`,
    });
  }
  return out;
}

/** Nudge instruction-ish sections toward positive phrasing (guardrails exempt). */
function lintPositive(name: SectionName, text: string): Violation[] {
  if (!["context", "objective", "steps"].includes(name)) return [];
  if (/\b(do not|don'?t|never|avoid)\b/i.test(text)) {
    return [
      {
        rule: "prefer-positive",
        severity: "warn",
        where: name,
        message: `${name}: prefer positive phrasing — say what to do, not what to avoid (guardrails are the place for "no …")`,
      },
    ];
  }
  return [];
}

/** Reference material reads best near the top (a generator invariant). */
function lintOrder(sections: Section[]): Violation[] {
  const indexOf = (n: SectionName) => sections.findIndex((s) => s.name === n);
  const refs = indexOf("references");
  if (refs < 0) return [];
  const out: Violation[] = [];
  for (const after of ["objective", "steps", "examples"] as SectionName[]) {
    const i = indexOf(after);
    if (i >= 0 && i < refs) {
      out.push({
        rule: "references-at-top",
        severity: "warn",
        where: "references",
        message: `<references> appears after <${after}> — reference material reads best near the top (auto-fixed on generate)`,
      });
    }
  }
  return out;
}

/**
 * Run every invariant against a draft. Non-throwing: returns all findings
 * (errors and warnings). generateXml({injectionReady}) escalates errors via
 * assertInjectable; the popup can surface warnings inline.
 */
export function lintDraft(draft: GrillDraft): Violation[] {
  const out: Violation[] = [];
  for (const section of draft.sections) {
    const text = sectionText(section);
    out.push(...lintEmphasis(text, section.name));
    out.push(...lintPositive(section.name, text));
  }
  out.push(...lintOrder(draft.sections));
  return out;
}

/**
 * Throw unless the draft is ready to inject into a coding agent:
 *   - no all-caps emphasis (error-level lint),
 *   - <objective mode> resolved to implement | advise,
 *   - no open question slots left,
 *   - <success_criteria> present (a definition of done + self-check).
 * Ordering/positive-phrasing warnings do not block (generate auto-fixes order).
 */
export interface InjectableOptions {
  /**
   * Pure-dictation contract (simple mode + grill off): the prompt carries only
   * what the user actually said, so the two normally-required fields —
   * a resolved <objective mode> and <success_criteria> — may be absent.
   * Everything else (lint errors, unresolved question slots) still applies.
   */
  lenient?: boolean;
}

export function assertInjectable(draft: GrillDraft, opts: InjectableOptions = {}): void {
  const problems = lintDraft(draft)
    .filter((v) => v.severity === "error")
    .map((v) => v.message);

  const objective = getSection(draft, "objective");
  const mode = objective?.attrs?.mode;
  if (!opts.lenient) {
    if (!objective) {
      problems.push("missing <objective> — state implement vs. advise");
    } else if (!mode || mode === "?") {
      problems.push('<objective mode> is unresolved — set "implement" or "advise"');
    } else if (!OBJECTIVE_MODES.includes(mode as ObjectiveMode)) {
      problems.push(`invalid <objective mode="${mode}"> — use "implement" or "advise"`);
    }
  } else if (mode && mode !== "?" && !OBJECTIVE_MODES.includes(mode as ObjectiveMode)) {
    // Lenient still rejects a *stated but invalid* mode.
    problems.push(`invalid <objective mode="${mode}"> — use "implement" or "advise"`);
  }

  if (draft.sections.some((s) => s.segments.some((seg) => seg.source === "question"))) {
    problems.push("draft still has open question slots — resolve them before injecting");
  }

  const success = getSection(draft, "success_criteria");
  if (!opts.lenient && (!success || sectionText(success).trim() === "")) {
    problems.push("missing <success_criteria> — define done and how to self-verify");
  }

  if (problems.length > 0) {
    throw new Error(`draft is not injection-ready: ${problems.join("; ")}`);
  }
}

// ── generate ────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Indent unit; default two spaces. The popup mirrors this for WYSIWYG edits. */
  indent?: string;
  /** When true, assertInjectable(draft) runs first and throws if not ready. */
  injectionReady?: boolean;
  /**
   * Pure-dictation contract (see InjectableOptions): relaxes the gate and,
   * when the objective mode was never stated, omits the mode attribute
   * instead of emitting a "?" placeholder into the final document.
   */
  lenient?: boolean;
}

function renderInner(segments: Segment[]): string {
  return segments.map((seg) => escapeXml(seg.text)).join("");
}

/**
 * Compile a GrillDraft into one clean <task> XML document.
 *
 * Sections are emitted in SECTION_ORDER (so references land near the top no
 * matter the input order). Empty sections are dropped, except <objective>,
 * which always carries its mode. With injectionReady the draft must pass
 * assertInjectable first.
 */
export function generateXml(draft: GrillDraft, opts: GenerateOptions = {}): string {
  const indent = opts.indent ?? "  ";
  if (opts.injectionReady) assertInjectable(draft, { lenient: opts.lenient });

  // First occurrence of each section wins (defensive against duplicates).
  const bySection = new Map<SectionName, Section>();
  for (const s of draft.sections) if (!bySection.has(s.name)) bySection.set(s.name, s);

  const lines: string[] = ["<task>"];
  for (const name of SECTION_ORDER) {
    const section = bySection.get(name);
    if (!section) continue;

    const body = renderInner(section.segments);
    if (body.trim() === "" && name !== "objective") continue;

    let attrs = "";
    if (name === "objective") {
      const mode = section.attrs?.mode;
      // Lenient (pure dictation): a never-stated mode is simply omitted rather
      // than shipping a "?" placeholder into the injected document.
      attrs = opts.lenient && (!mode || mode === "?") ? "" : ` mode="${escapeAttr(mode ?? "?")}"`;
    } else if (section.attrs) {
      for (const [k, v] of Object.entries(section.attrs)) attrs += ` ${k}="${escapeAttr(v)}"`;
    }

    lines.push(`${indent}<${name}${attrs}>`);
    for (const line of body.split("\n")) lines.push(`${indent}${indent}${line}`);
    lines.push(`${indent}</${name}>`);
  }
  lines.push("</task>");
  return lines.join("\n");
}

// ── parse (tolerant) ────────────────────────────────────────────────────────

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = unescapeXml(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/**
 * Parse a <task> document into a GrillDraft. This is a targeted parser for our
 * known tag set — not a general XML parser — which makes it robust to the quirks
 * LLMs and humans introduce: extra whitespace/indentation, comments, XML
 * entities, attribute quoting, CRLF, reordered sections, and stray unknown tags
 * (ignored). Provenance is not recoverable from clean XML, so parsed segments
 * default to source "said".
 *
 * Throws only on fundamental breakage (no <task> root).
 */
export function parseXml(xml: string): GrillDraft {
  const withoutComments = String(xml).replace(/<!--[\s\S]*?-->/g, "");

  const root = withoutComments.match(/<task\b[^>]*>([\s\S]*)<\/task>/i);
  if (!root) {
    throw new Error("parseXml: no <task>…</task> root element found");
  }
  const inner = root[1];

  const sections: Section[] = [];
  const tagRe = new RegExp(
    `<(${SECTION_ORDER.join("|")})\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(inner)) !== null) {
    const name = m[1].toLowerCase() as SectionName;
    const attrs = parseAttrs(m[2] ?? "");
    const text = unescapeXml(m[3] ?? "").trim();
    const section: Section = {
      name,
      segments: text === "" ? [] : [{ text, source: "said" }],
    };
    if (Object.keys(attrs).length > 0) section.attrs = attrs;
    sections.push(section);
  }

  return { sections, questions: [] };
}
