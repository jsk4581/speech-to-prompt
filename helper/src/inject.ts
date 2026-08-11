// STP — injection gate (M4). The last step before the confirmed prompt enters
// the coding session.
//
// The grill bridge already validated + normalized the confirmed XML into a file.
// This re-checks it one final time and prints the clean <task> document to stdout
// — that stdout is what the skill's `!bash` injects as the single work order.
//
//   node dist/inject.js --in final.xml      # prints the validated XML, exit 0
//
// On any problem it writes the reason to stderr and exits non-zero, so a malformed
// or not-yet-ready prompt is never injected (the localhost-injection threat model,
// D2: only a fully-formed, invariant-clean prompt is allowed into the session).

import { readFile } from "node:fs/promises";
import { argv } from "node:process";
import { parseXml, assertInjectable } from "./xml.js";

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const inPath = flag("in");
  if (!inPath) throw new Error("inject: --in <final.xml> is required");

  const xml = await readFile(inPath, "utf8");
  // Re-parse and re-assert the invariants — defense in depth even though the
  // grill bridge already normalized this file.
  assertInjectable(parseXml(xml));

  // stdout = the injected prompt. Nothing else goes here.
  process.stdout.write(xml.trim() + "\n");
}

main().catch((e) => {
  process.stderr.write(`inject: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
