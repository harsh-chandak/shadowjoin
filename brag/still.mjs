#!/usr/bin/env node
/**
 * The recovery figure, as a still sized for a portfolio card.
 *
 * Two reasons this exists rather than a frame grab of the GIF. The GIF is a
 * hand-authored HTML mock-up, like Concord Engine's was before it was
 * re-recorded, so no frame of it is real output. And at a 440px card the
 * source text would render around 5px, under the ~9px floor for reading, so
 * a screenshot of a terminal does not survive the trip whatever it contains.
 *
 * This runs the real scan against the committed example data and typesets
 * what it printed. Every number below came out of the program on this run.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ARGS = ["dist/cli.js", "scan",
  "--left", "examples/sp500.csv", "--left-key", "Security", "--left-truth", "Symbol",
  "--right", "examples/listings.json", "--right-key", "name", "--right-truth", "symbol"];

const out = execFileSync(process.execPath, ARGS, {
  cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
});

// Keep the counts and the verification. The per-rule tables below them are
// the useful part in a terminal and noise in an image.
const all = out.split("\n").map((l) => l.replace(/\s+$/, ""));
const stop = all.findIndex((l) => /^\s*rule\s/.test(l));
const kept = all.slice(0, stop === -1 ? all.length : stop).filter((l, i, a) =>
  !(l === "" && a[i - 1] === ""));
const hidden = (stop === -1 ? 0 : all.length - stop) - 1;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paint = (l) =>
  /LOWER BOUND/.test(l) ? `<span class="yl">${esc(l)}</span>`
  : /verified against ground truth/.test(l) ? `<span class="gn">${esc(l)}</span>`
  : /recovered by shadow join/.test(l) ? `<span class="big">${esc(l)}</span>`
  : esc(l);

const W = 880;
const html = `<!doctype html><meta charset="utf-8"><style>
 *{margin:0;padding:0;box-sizing:border-box}
 html,body{width:${W}px;background:#010409;font-family:ui-monospace,"SF Mono",Menlo,monospace}
 .term{margin:16px;background:#0d1117;border:1px solid #30363d;border-radius:14px;overflow:hidden}
 .bar{height:44px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;padding:0 18px;gap:10px}
 .dot{width:13px;height:13px;border-radius:50%}
 .title{color:#6e7681;font-size:18px;margin-left:12px}
 .body{padding:20px 26px;font-size:24px;line-height:1.5;color:#c9d1d9;white-space:pre-wrap;word-break:break-word}
 .cmd{color:#58a6ff}.dimline{color:#6e7681}.yl{color:#d29922}.gn{color:#3fb950}.big{color:#f0f6fc;font-weight:600}.dim{color:#8b949e}
</style>
<div class="term">
 <div class="bar"><div class="dot" style="background:#ff5f56"></div><div class="dot" style="background:#ffbd2e"></div><div class="dot" style="background:#27c93f"></div><div class="title">shadowjoin — S&amp;P 500 against NYSE/Nasdaq listings</div></div>
 <div class="body"><span class="dimline">$ </span><span class="cmd">shadowjoin scan --left sp500.csv --right listings.json</span>
${kept.map(paint).join("\n")}<span class="dim">  … ${hidden} more lines</span></div>
</div>`;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: 100, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle0" });
const h = await page.evaluate(() => document.querySelector(".term").getBoundingClientRect().bottom + 16);
await page.setViewport({ width: W, height: Math.ceil(h), deviceScaleFactor: 1 });
const buf = await page.screenshot({ type: "png" });
await browser.close();
writeFileSync(resolve(ROOT, "assets/recovery-card.png"), buf);
console.log(`${W}x${Math.ceil(h)}, ${(buf.length / 1024).toFixed(0)} KiB -> assets/recovery-card.png`);
