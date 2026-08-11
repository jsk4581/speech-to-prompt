// STP demo frame renderer.
// Steps demo/movie.html's window.seek(t) once per frame and screenshots each
// one — deterministic, so frames are exact regardless of render speed. Assemble
// the result with ffmpeg (see demo/build.sh).
//
// Usage:  CHROME=/path/to/chrome node demo/shoot.mjs [outDir] [fps]
//   CHROME defaults to a Playwright-cache chromium if one exists.
//   FRAMES env: "a,b" ms range to render only a slice (preview).
//   MOVIE env: scene file to shoot (default movie.html; e.g. movie-compact.html).
import { launch } from "puppeteer-core";
import { mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? join(here, "_frames"));
const FPS = parseInt(process.argv[3] ?? "30", 10);

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).sort().reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-win64/chrome.exe"]) {
        const c = join(cache, d, rel);
        if (existsSync(c)) return c;
      }
    }
  }
  return null;
}

const exe = findChrome();
if (!exe) {
  console.error("No chromium found — set CHROME=/path/to/chrome");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".png")) unlinkSync(join(OUT, f));

const browser = await launch({
  executablePath: exe,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, process.env.MOVIE ?? "movie.html")).href, { waitUntil: "networkidle0" });
await page.evaluate(() => window.ready);

const DURATION = await page.evaluate(() => window.DURATION);
let [from, to] = (process.env.FRAMES ?? `0,${DURATION}`).split(",").map(Number);
const step = 1000 / FPS;
const first = Math.floor(from / step);
const last = Math.ceil(to / step);
console.log(`chrome=${exe}`);
console.log(`DURATION=${DURATION}ms fps=${FPS} frames=${last - first + 1} → ${OUT}`);

for (let i = first; i <= last; i++) {
  await page.evaluate((t) => window.seek(t), Math.min(i * step, DURATION));
  await page.screenshot({ path: join(OUT, `frame_${String(i).padStart(5, "0")}.png`) });
  if ((i - first) % 100 === 0) console.log(`  ${i - first}/${last - first}`);
}
await browser.close();
console.log("done");
