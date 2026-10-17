import puppeteer from "puppeteer-core";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 20;
const outDir = resolve(HERE, "frames");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars", "--disable-lcd-text"],
});
const page = await browser.newPage();
await page.setViewport({ width: 880, height: 600, deviceScaleFactor: 1 });
await page.goto("file://" + resolve(HERE, "video.html"), { waitUntil: "networkidle0" });
await page.waitForFunction("window.__ready === true", { timeout: 15000 });

const DUR = await page.evaluate(() => window.__duration);
console.log(`session runs ${DUR.toFixed(1)}s`);
const total = Math.round(DUR * FPS);
for (let i = 0; i < total; i++) {
  await page.evaluate((tt) => window.renderAt(tt), i / FPS);
  await page.screenshot({ path: `${outDir}/f${String(i).padStart(5, "0")}.png`, type: "png" });
  if ((i + 1) % 60 === 0) process.stdout.write(`  ${i + 1}/${total}\n`);
}
await browser.close();
console.log(`${total} frames -> ${outDir}`);
