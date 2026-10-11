import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, normalize, parseCsv } from "../dist/index.js";

const L = (id, key, truth) => ({ id, key, ...(truth ? { truth } : {}) });

test("exact matches are counted as the baseline, not as recoveries", () => {
  const r = scan([L("1", "Acme")], [L("a", "Acme")]);
  assert.equal(r.exactMatches, 1);
  assert.equal(r.recovered, 0);
  assert.equal(r.lowerBoundLossPct, 0);
});

test("a corporate suffix difference is recovered and attributed to a rule", () => {
  const r = scan([L("1", "Acme")], [L("a", "Acme Inc.")]);
  assert.equal(r.exactMatches, 0);
  assert.equal(r.recovered, 1);
  assert.equal(r.lowerBoundLossPct, 100);
  assert.ok(r.byRule.find((x) => x.rule === "corp-suffix" && x.recovered === 1));
});

test("ground truth on both sides yields precision", () => {
  const r = scan(
    [L("1", "Acme", "ACME"), L("2", "Globex", "GLX")],
    [L("a", "Acme Inc.", "ACME"), L("b", "Globex Inc.", "WRONG")],
  );
  assert.equal(r.verified, 1);
  assert.equal(r.contradicted, 1);
  assert.equal(r.precision, 50);
});

test("truth is compared loosely so BRK.B and BRK-B agree", () => {
  const r = scan([L("1", "Berkshire", "BRK.B")], [L("a", "Berkshire Inc.", "BRK-B")]);
  assert.equal(r.verified, 1);
});

test("a key shared by several right rows is reported as ambiguous, not verified", () => {
  const r = scan(
    [L("1", "Fox", "FOXA")],
    [L("a", "Fox Inc.", "FOXA"), L("b", "Fox Inc.", "FOX")],
  );
  assert.equal(r.ambiguous, 1);
  assert.equal(r.verified, 0);
  assert.ok(r.warnings.some((w) => w.includes("tie-breaker")));
});

test("no ground truth means the figure is flagged as unverified", () => {
  const r = scan([L("1", "Acme")], [L("a", "Acme Inc.")]);
  assert.equal(r.precision, null);
  assert.ok(r.warnings.some((w) => w.includes("No ground truth")));
});

test("the greedy stack orders rules by marginal recovery", () => {
  const left = [L("1", "Acme"), L("2", "Globex & Co"), L("3", "Initech")];
  const right = [L("a", "Acme Inc."), L("b", "Globex and Company"), L("c", "Initech Corp.")];
  const r = scan(left, right);
  assert.ok(r.stack.length > 0);
  assert.ok(r.stack[0].marginal >= (r.stack[1]?.marginal ?? 0));
  assert.equal(r.stack.at(-1).cumulative, 3);
});

test("per-rule counts do not have to sum to the total, and say so", () => {
  const r = scan([L("1", "The Acme Company")], [L("a", "Acme")]);
  assert.ok(r.warnings.some((w) => w.includes("will not sum")));
});

test("rules can be restricted and unknown rules are rejected", () => {
  const r = scan([L("1", "Acme")], [L("a", "Acme Inc.")], { rules: ["corp-suffix"] });
  assert.equal(r.recovered, 1);
  assert.throws(() => scan([], [], { rules: ["nope"] }), /Unknown rule/);
});

test("samples can be redacted without changing the counts", () => {
  const r = scan([L("1", "Acme")], [L("a", "Acme Inc.")], { redactSamples: true });
  assert.equal(r.recovered, 1);
  assert.match(r.samplePairs[0].leftKey, /^#[0-9a-f]{8}$/);
});

test("normalize folds case and strips diacritics by default", () => {
  assert.equal(normalize("Café  MÜNCHEN"), "cafe munchen");
});

test("the csv parser handles quoted commas and doubled quotes", () => {
  const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n');
  assert.deepEqual(rows[1], ["x, y", 'he said "hi"']);
});

test("warns when the full rule set recovers fewer than the best subset", () => {
  // "a b" vs "b a" is recovered by sort-tokens, but adding despace first
  // collapses both sides differently and loses it.
  const left = [L("1", "Antigua & Barbuda"), L("2", "x y z"), L("3", "p q")];
  const right = [L("a", "Antigua and Barbuda"), L("b", "z y x"), L("c", "q p")];
  const all = scan(left, right);
  const best = scan(left, right, { rules: all.stack.map((s2) => s2.rule) });
  assert.ok(best.recovered >= all.recovered, "the greedy subset should never do worse");
});

test("the recommended stack is a usable rules argument", () => {
  const left = [L("1", "Acme & Sons"), L("2", "Initech")];
  const right = [L("a", "Acme and Sons"), L("b", "Initech Corp.")];
  const first = scan(left, right);
  const rerun = scan(left, right, { rules: first.stack.map((s2) => s2.rule) });
  assert.equal(rerun.recovered, first.recovered);
});

test("an empty side is reported rather than crashing", () => {
  const r = scan([], [L("a", "Acme")]);
  assert.equal(r.leftRows, 0);
  assert.ok(r.warnings.some((w) => w.includes("empty")));
});
