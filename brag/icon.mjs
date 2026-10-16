#!/usr/bin/env node
/**
 * Render the listing icon.
 *
 * The plugin directory takes the icon once — the first time the plugin is
 * saved or submitted — and never again. Square PNG or JPEG, 512 to 2048 px,
 * under 2 MB; SVG and WebP are rejected.
 *
 * The mark: two sets joined. The lens where they overlap is what an exact
 * join returns, and the crescent beside it is what it silently dropped —
 * which is the only thing this tool measures.
 */
import puppeteer from "puppeteer-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZE = 1024;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; width:${SIZE}px; height:${SIZE}px; }
  body { background:#0d1117; display:flex; align-items:center; justify-content:center; }
  svg { display:block; }
</style>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#161b22"/>
      <stop offset="1" stop-color="#0d1117"/>
    </linearGradient>
    <clipPath id="left"><circle cx="420" cy="512" r="236"/></clipPath>
    <clipPath id="right"><circle cx="604" cy="512" r="236"/></clipPath>
    <mask id="leftOnly">
      <circle cx="420" cy="512" r="236" fill="white"/>
      <circle cx="604" cy="512" r="236" fill="black"/>
    </mask>
  </defs>

  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <rect x="8" y="8" width="1008" height="1008" rx="216" fill="none" stroke="#30363d" stroke-width="16"/>

  <!-- the lens: what the exact join actually returned -->
  <g clip-path="url(#left)">
    <circle cx="604" cy="512" r="236" fill="#8b949e" fill-opacity="0.45"/>
  </g>

  <!-- everything in the left set with no exact match: what it dropped, and
       the only thing this tool measures -->
  <circle cx="420" cy="512" r="236" fill="#d29922" mask="url(#leftOnly)"/>

  <!-- both outlines, or the two fills read as one circle in shadow rather
       than as two sets being joined -->
  <circle cx="420" cy="512" r="236" fill="none" stroke="#c9d1d9" stroke-width="26"/>
  <circle cx="604" cy="512" r="236" fill="none" stroke="#c9d1d9" stroke-width="26"/>
</svg>`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle0" });
const buf = await page.screenshot({ type: "png" });
await browser.close();

const out = resolve(HERE, "../.claude-plugin/icon.png");
writeFileSync(out, buf);
console.log(`${SIZE}x${SIZE} png, ${(buf.length / 1024).toFixed(0)} KiB -> ${out}`);
