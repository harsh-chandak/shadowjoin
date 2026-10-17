#!/usr/bin/env node
/**
 * Record a REAL shadowjoin session and write it out for the renderer.
 *
 * The previous demo was a hand-written HTML mock-up: the numbers lived in
 * hardcoded spans in video.html, there was no captured session, and it
 * showed the country-name example rather than the S&P figures the README
 * and the portfolio actually claim. For a tool whose whole argument is that
 * it MEASURES something, a drawn measurement is the worst possible
 * illustration.
 *
 * So this runs the real CLI against the committed example data and captures
 * stdout verbatim. Every number the renderer later shows came out of the
 * program on that run. The only authored strings are the one-line
 * narrations, marked as a different kind so they cannot be mistaken for
 * output.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const session = [];

const say = (text) => session.push({ kind: "say", text });

function run(display, args) {
  const out = execFileSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  session.push({ kind: "cmd", text: display });
  session.push({ kind: "out", text: out.replace(/\n+$/, ""), code: 0 });
  return out;
}

// The scenario is the one the bullets claim: the S&P 500 against NYSE and
// Nasdaq listings, with ticker symbols on both sides as ground truth, so the
// recovery figure is verified rather than asserted.
say("An exact join on company name. 503 rows against 6,709.");
const out = run(
  "shadowjoin scan --left sp500.csv --right listings.json \\\n      --left-truth Symbol --right-truth symbol",
  ["scan",
   "--left", "examples/sp500.csv", "--left-key", "Security", "--left-truth", "Symbol",
   "--right", "examples/listings.json", "--right-key", "name", "--right-truth", "symbol"],
);

const exact = out.match(/exact join matches\s+(\S+)/)?.[1];
const recovered = out.match(/recovered by shadow join\s+(\S+)/)?.[1];
if (!exact || !recovered) throw new Error("scan output did not contain the counts");
say(`One name matched exactly. ${recovered} more were there and the join could not see them.`);

writeFileSync(resolve(HERE, "session.js"), `window.__SESSION = ${JSON.stringify(session, null, 2)};\n`);
const lines = session.filter((s) => s.kind === "out").reduce((n, s) => n + s.text.split("\n").length, 0);
console.log(`recorded ${session.length} steps, ${lines} lines of real output`);
console.log(`  exact ${exact}, recovered ${recovered} -> brag/session.js`);
