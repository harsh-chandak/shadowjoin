import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, normalize, rulesByIds, ALL_RULE_IDS } from "../dist/index.js";

// A single-column row, the way every existing caller builds them.
const L = (id, key, truth) => ({ id, key, ...(truth ? { truth } : {}) });
// A composite row: the tuple is the join key.
const C = (id, keys, truth) => ({ id, keys, ...(truth ? { truth } : {}) });

const NAME_CITY = { keyLabels: ["name", "city"] };
const bucket = (report, labels) => report.agreement.find((b) => b.labels.join() === labels.join());

// --- a join key spanning several columns -------------------------------------

test("a composite key agreeing on every component is the baseline, not a recovery", () => {
  const r = scan([C("1", ["Acme", "Boston"])], [C("a", ["Acme", "Boston"])], NAME_CITY);
  assert.equal(r.exactMatches, 1);
  assert.equal(r.recovered, 0);
  assert.equal(r.lowerBoundLossPct, 0);
  assert.deepEqual(r.keyComponents, ["name", "city"]);
});

test("every component must agree before a composite pair is counted", () => {
  // Same name, different city: the exact join is right to drop this, and the
  // shadow matcher must not claim it either.
  const r = scan([C("1", ["Acme", "Boston"])], [C("a", ["Acme Inc.", "Chicago"])], NAME_CITY);
  assert.equal(r.exactMatches, 0);
  assert.equal(r.recovered, 0, "a rule that fixes the name does not fix the city");
  assert.equal(r.lowerBoundLossPct, 0);
});

test("a composite pair recovered on one component is counted once, with both values", () => {
  const r = scan([C("1", ["Acme", "Boston"], "A1")], [C("a", ["Acme Inc.", "Boston"], "A1")], NAME_CITY);
  assert.equal(r.recovered, 1);
  assert.equal(r.lowerBoundLossPct, 100);
  assert.equal(r.verified, 1);
  assert.ok(r.byRule.find((x) => x.rule === "corp-suffix" && x.recovered === 1));
  assert.deepEqual(r.samplePairs[0].leftKeys, ["Acme", "Boston"]);
  assert.deepEqual(r.samplePairs[0].rightKeys, ["Acme Inc.", "Boston"]);
  assert.equal(r.samplePairs[0].leftKey, "Acme | Boston");
});

test("components are positional, so a swapped tuple is a different key", () => {
  const r = scan([C("1", ["Acme", "Boston"])], [C("a", ["Boston", "Acme"])], NAME_CITY);
  assert.equal(r.exactMatches, 0);
  assert.equal(r.recovered, 0);
});

// --- partial agreement, which is the point -----------------------------------

test("partial agreement is reported explicitly: the name matches, the city does not", () => {
  const r = scan([C("1", ["Acme", "Boston"], "A1")], [C("a", ["Acme", "Chicago"], "A1")], NAME_CITY);
  const name = bucket(r, ["name"]);
  assert.ok(name, "there must be a bucket for agreeing on the name alone");
  assert.equal(name.leftRows, 1);
  assert.equal(name.full, false);
  assert.equal(name.verified, 1, "ground truth says this really is the same entity");
  assert.equal(r.recovered, 0, "partial agreement must never be counted");
  assert.equal(r.lowerBoundLossPct, 0, "and must never move the floor");
  assert.ok(r.warnings.some((w) => w.includes("NOT counted in the floor")));
});

test("agreeing on the name but not the city is distinguishable from agreeing on neither", () => {
  const left = [
    C("1", ["Acme", "Boston"]),        // the name agrees, the city does not
    C("2", ["Initech", "Boston"]),     // the city agrees, the name does not
    C("3", ["Umbrella", "Raccoon"]),   // nothing agrees
  ];
  const right = [C("a", ["Acme", "Chicago"]), C("b", ["Globex", "Boston"])];
  const r = scan(left, right, NAME_CITY);

  assert.equal(bucket(r, ["name"]).leftRows, 1);
  assert.equal(bucket(r, ["city"]).leftRows, 1);
  assert.equal(bucket(r, []).leftRows, 1, "agreeing on nothing is its own bucket");
  assert.equal(r.recovered, 0);

  const pair = r.partialPairs.find((p) => p.leftId === "1");
  assert.deepEqual(
    pair.components.map((c) => [c.label, c.agrees]),
    [["name", true], ["city", false]],
    "the pair says which component agreed and which did not",
  );
});

test("the agreement buckets partition the rows the exact join missed", () => {
  const left = [
    C("1", ["Acme", "Boston"], "A1"),
    C("2", ["Acme Inc.", "Boston"], "A1"),
    C("3", ["Globex", "Chicago"], "G1"),
    C("4", ["Initech", "Austin"], "I1"),
    C("5", ["Umbrella & Co", "Raccoon City"], "U1"),
    C("6", ["Nowhere", "Nowhereville"], "N1"),
  ];
  const right = [
    C("a", ["Acme Inc.", "Boston"], "A1"),
    C("b", ["Globex", "Chicago, IL"], "G1"),
    C("c", ["Initech Corp.", "Austin"], "I1"),
    C("d", ["Umbrella and Co", "Raccoon City"], "U1"),
  ];
  const r = scan(left, right, NAME_CITY);

  const summed = r.agreement.reduce((n, b) => n + b.leftRows, 0);
  assert.equal(summed, r.leftRows - r.exactMatches, "every missed row lands in exactly one bucket");

  const full = r.agreement.filter((b) => b.full);
  assert.equal(full.length, 1, "exactly one bucket may be counted");
  assert.equal(full[0].leftRows, r.recovered, "the full-agreement bucket IS the floor");
  assert.deepEqual(full[0].labels, ["name", "city"]);
});

test("a blank component is never evidence of agreement", () => {
  // Neither side has a city. Two blanks must not read as "the city agrees".
  const r = scan([C("1", ["Acme", ""])], [C("a", ["Globex", ""])], NAME_CITY);
  assert.equal(r.recovered, 0);
  assert.equal(bucket(r, ["city"]), undefined, "no bucket may claim the blanks agreed");
  assert.equal(bucket(r, []).leftRows, 1);
});

test("a component that normalizes to nothing cannot be recovered", () => {
  // Punctuation-only cities normalize to empty. Recovering this pair would mean
  // claiming a match on the strength of two empty strings.
  const r = scan([C("1", ["Acme", "-"])], [C("a", ["Acme Inc.", "."])], NAME_CITY);
  assert.equal(r.recovered, 0);
  assert.equal(r.lowerBoundLossPct, 0);
});

// --- the floor stays a floor -------------------------------------------------

test("FLOOR: every composite row counted as recovered is independently a real miss", () => {
  const left = [
    C("1", ["Acme", "Boston"], "A1"),
    C("2", ["The Globex Company", "St. Louis"], "G1"),
    C("3", ["Initech", "Austin"], "I1"),
    C("4", ["Umbrella & Co", "Raccoon City"], "U1"),
    C("5", ["Soylent", "Néw York"], "S1"),
    C("6", ["Massive Dynamic", "Boston"], "M1"),
    C("7", ["Wayne Enterprises", "Gotham"], "W1"),
    C("8", ["Stark Industries", ""], "T1"),
    C("9", ["Tyrell", "Los Angeles"], "Y1"),
  ];
  const right = [
    C("a", ["Acme Inc.", "boston"], "A1"),
    C("b", ["Globex Company", "St Louis"], "G1"),
    C("c", ["Initech", "Austin"], "I1"),
    C("d", ["Umbrella and Co", "Raccoon  City"], "U1"),
    C("e", ["Soylent", "New York"], "S1"),
    C("f", ["Massive Dynamic", "Chicago"], "M1"),
    C("g", ["Wayne Enterprises Ltd", "Gotham City"], "W1"),
    C("h", ["Stark Industries", ""], "T1"),
    C("i", ["Tyrell Corp", "Los Angeles"], "Y1"),
  ];
  const r = scan(left, right, { ...NAME_CITY, maxSamplePairs: 100 });

  // Recompute both conditions from scratch, with the public primitives only.
  const tuple = (components, ruleIds) => {
    const rules = rulesByIds(ruleIds);
    const parts = components.map((c) => normalize(c, rules));
    return parts.some((p) => p === "") ? null : JSON.stringify(parts);
  };
  const agreesSomewhere = (components, ruleIds) => {
    const key = tuple(components, ruleIds);
    return key !== null && right.some((row) => tuple(row.keys, ruleIds) === key);
  };
  const exactTuples = new Set(right.map((row) => JSON.stringify(row.keys)));

  assert.equal(r.samplePairs.length, r.recovered, "every recovery is sampled here");
  for (const pair of r.samplePairs) {
    const row = left.find((l) => l.id === pair.leftId);
    assert.ok(
      !exactTuples.has(JSON.stringify(row.keys)),
      `${pair.leftId} was counted as lost although the exact join matches it`,
    );
    // The rule the report attributes it to has to be a rule that explains it: a
    // named rule on its own, or — for "combined" — the recommended stack or the
    // whole enabled set. Nothing weaker may count towards the floor.
    const claimed = pair.rule === "combined" ? [r.stack.map((s) => s.rule), r.rulesApplied] : [[pair.rule]];
    assert.ok(
      claimed.some((ruleIds) => agreesSomewhere(row.keys, ruleIds)),
      `${pair.leftId} counted as recovered with no right row agreeing on every component under ${pair.rule}`,
    );
  }

  assert.ok(r.recovered <= r.leftRows - r.exactMatches, "recoveries come out of the missed rows");
  assert.equal(r.lowerBoundLossPct, Number(((r.recovered / r.leftRows) * 100).toFixed(2)));
});

test("FLOOR: a partial-agreement row is never also a recovered row", () => {
  const left = [C("1", ["Acme", "Boston"]), C("2", ["Globex", "Chicago"])];
  const right = [C("a", ["Acme Inc.", "Boston"]), C("b", ["Globex", "Cicero"])];
  const r = scan(left, right, { ...NAME_CITY, maxSamplePairs: 100 });

  const recoveredIds = new Set(r.samplePairs.map((p) => p.leftId));
  for (const pair of r.partialPairs) {
    assert.ok(!recoveredIds.has(pair.leftId), `${pair.leftId} is both recovered and partial`);
  }
  assert.equal(r.recovered, 1);
  assert.equal(bucket(r, ["name"]).leftRows, 1);
});

test("turning the agreement pass off leaves the floor untouched", () => {
  const left = [C("1", ["Acme", "Boston"]), C("2", ["Globex", "Chicago"])];
  const right = [C("a", ["Acme Inc.", "Boston"]), C("b", ["Globex", "Cicero"])];
  const on = scan(left, right, NAME_CITY);
  const off = scan(left, right, { ...NAME_CITY, agreement: false });
  assert.equal(off.recovered, on.recovered);
  assert.equal(off.lowerBoundLossPct, on.lowerBoundLossPct);
  assert.equal(off.agreement, undefined);
  assert.equal(off.partialPairs, undefined);
});

// --- backwards compatibility -------------------------------------------------

test("a single-column scan reports exactly the fields it always did", () => {
  const r = scan([L("1", "Acme")], [L("a", "Acme Inc.")]);
  assert.deepEqual(Object.keys(r), [
    "generatedAt", "leftRows", "rightRows", "exactMatches", "exactMatchRate", "recovered",
    "unexplained", "reachableMatchRate", "lowerBoundLossPct", "byRule", "stack", "verified",
    "contradicted", "ambiguous", "unverifiable", "precision", "samplePairs", "nearMisses",
    "noCandidate", "warnings", "rulesApplied",
  ]);
  assert.ok(!("keyComponents" in r) && !("agreement" in r) && !("partialPairs" in r));
  assert.ok(!("leftKeys" in r.samplePairs[0]), "sample pairs keep their old shape too");
});

test("a one-component composite key behaves exactly like a single-column one", () => {
  const single = scan([L("1", "Acme", "A1")], [L("a", "Acme Inc.", "A1")]);
  const asTuple = scan([C("1", ["Acme"], "A1")], [C("a", ["Acme Inc."], "A1")]);
  for (const field of ["exactMatches", "recovered", "lowerBoundLossPct", "verified", "unexplained"]) {
    assert.equal(asTuple[field], single[field], field);
  }
  assert.deepEqual(asTuple.warnings, single.warnings);
  assert.equal(asTuple.samplePairs[0].leftKey, "Acme");
  assert.ok(!("agreement" in asTuple), "one component is not a composite key");
});

test("the two row shapes can be mixed on a side without changing the key", () => {
  const left = [{ id: "1", key: "Acme of Boston", keys: ["Acme", "Boston"] }];
  const r = scan(left, [C("a", ["Acme Inc.", "Boston"])], NAME_CITY);
  assert.equal(r.recovered, 1, "`keys` decides the match");
  assert.equal(r.samplePairs[0].leftKey, "Acme of Boston", "`key` is used verbatim for display");
});

// --- degenerate input --------------------------------------------------------

test("an empty side is reported rather than crashing, with a composite key too", () => {
  const r = scan([], [C("a", ["Acme", "Boston"])], NAME_CITY);
  assert.equal(r.leftRows, 0);
  assert.equal(r.recovered, 0);
  assert.equal(r.lowerBoundLossPct, 0);
  assert.ok(r.warnings.some((w) => w.includes("empty")));
  assert.deepEqual(r.keyComponents, ["name", "city"], "the key is still described");
  assert.deepEqual(r.agreement, [], "nothing was missed, so there is nothing to group");

  const other = scan([C("1", ["Acme", "Boston"])], [], NAME_CITY);
  assert.equal(other.rightRows, 0);
  assert.equal(other.recovered, 0);
  assert.ok(other.warnings.some((w) => w.includes("empty")));
  assert.equal(bucket(other, []).leftRows, 1, "the one missed row agrees on nothing");

  const both = scan([], [], { keyLabels: ["only"] });
  assert.equal(both.leftRows, 0);
  assert.equal(both.lowerBoundLossPct, 0);
});

test("a key of a different width on each side is refused, not padded", () => {
  assert.throws(
    () => scan([C("1", ["Acme", "Boston"])], [C("a", ["Acme"])]),
    /same number of components/,
  );
  assert.throws(
    () => scan([C("1", ["Acme", "Boston"]), C("2", ["Globex"])], [C("a", ["Acme", "Boston"])]),
    /same key columns/,
  );
});

test("a row with no key at all is refused, with a message saying what to supply", () => {
  assert.throws(() => scan([{ id: "1" }], [C("a", ["Acme"])]), /carries no join key/);
  assert.throws(() => scan([{ id: "1", keys: [] }], [C("a", ["Acme"])]), /empty `keys`/);
});

test("labels must match the key they describe", () => {
  assert.throws(
    () => scan([C("1", ["Acme", "Boston"])], [C("a", ["Acme", "Boston"])], { keyLabels: ["name"] }),
    /one label per key column/,
  );
});

test("components get positional labels when none are supplied", () => {
  const r = scan([C("1", ["Acme", "Boston"])], [C("a", ["Acme", "Chicago"])]);
  assert.deepEqual(r.keyComponents, ["key 1", "key 2"]);
  assert.equal(bucket(r, ["key 1"]).leftRows, 1);
});

test("key components are redacted along with everything else", () => {
  const r = scan(
    [C("1", ["Acme", "Boston"]), C("2", ["Globex", "Chicago"])],
    [C("a", ["Acme Inc.", "Boston"]), C("b", ["Globex", "Cicero"])],
    { ...NAME_CITY, redactSamples: true },
  );
  assert.equal(r.recovered, 1, "redaction does not change the counts");
  for (const value of r.samplePairs[0].leftKeys) assert.match(value, /^#[0-9a-f]{8}$/);
  for (const c of r.partialPairs[0].components) {
    assert.match(c.leftValue, /^#[0-9a-f]{8}$/);
    assert.match(c.rightValue, /^#[0-9a-f]{8}$/);
  }
});

test("near misses on a composite key compare the whole tuple and stay uncounted", () => {
  const r = scan(
    [C("1", ["Cape Verde", "Praia"], "CPV")],
    [C("a", ["Cabo Verde", "Praia"], "CPV")],
    { keyLabels: ["country", "capital"] },
  );
  assert.equal(r.recovered, 0, "no rule explains it");
  assert.equal(r.lowerBoundLossPct, 0, "so the floor must not move");
  assert.equal(r.nearMisses.length, 1);
  assert.deepEqual(r.nearMisses[0].leftKeys, ["Cape Verde", "Praia"]);
  assert.equal(r.nearMisses[0].verification, "verified");
  assert.equal(bucket(r, ["capital"]).leftRows, 1, "and it is partial agreement on the capital");
});

test("a wide key reports agreement one column at a time rather than exploding", () => {
  const keys = (n, differ) => Array.from({ length: n }, (_, i) => (i === differ ? "x" : `c${i}`));
  const r = scan([C("1", keys(7, 3))], [C("a", keys(7, -1))]);
  assert.equal(r.keyComponents.length, 7);
  assert.equal(r.recovered, 0);
  assert.ok(
    r.agreement.find((b) => !b.full && b.components.length === 1),
    "single-column agreement is still reported for a wide key",
  );
});

test("the enabled rule set decides agreement, so restricting it narrows agreement", () => {
  const left = [C("1", ["Acme", "Saint Louis"])];
  const right = [C("a", ["Acme Inc.", "Chicago"])];
  const all = scan(left, right, NAME_CITY);
  assert.equal(bucket(all, ["name"]).leftRows, 1, "corp-suffix makes the names agree");
  assert.deepEqual(all.rulesApplied, ALL_RULE_IDS);

  const narrow = scan(left, right, { ...NAME_CITY, rules: ["despace"] });
  assert.equal(bucket(narrow, ["name"]), undefined, "without corp-suffix they do not");
  assert.equal(bucket(narrow, []).leftRows, 1);
});

// --- the paths a user actually touches ---------------------------------------

test("the CSV adapter reads several key columns into one composite key", async () => {
  const { rowsFromCsvText } = await import("../dist/index.js");
  const csv = "company,city,id\nAcme,Boston,1\nGlobex,,2\n,Chicago,3\n";

  const composite = rowsFromCsvText(csv, { keyColumn: ["company", "city"], idColumn: "id" });
  assert.equal(composite.length, 1, "a row missing any part of its key cannot be joined on it");
  assert.deepEqual(composite[0].keys, ["Acme", "Boston"]);
  assert.equal(composite[0].key, "Acme | Boston", "and carries a readable display key");

  const single = rowsFromCsvText(csv, { keyColumn: "company", idColumn: "id" });
  assert.equal(single.length, 2);
  assert.equal(single[0].key, "Acme");
  assert.ok(!("keys" in single[0]), "one column produces exactly the row shape it always did");

  assert.throws(() => rowsFromCsvText(csv, { keyColumn: [] }), /at least one column/);
  assert.throws(() => rowsFromCsvText(csv, { keyColumn: ["company", "nope"] }), /not found/);
});

test("the JSON adapter reads several key columns into one composite key", async () => {
  const { rowsFromJsonText } = await import("../dist/adapters/json.js");
  const json = JSON.stringify([
    { sku: "A-1", vendor: "Acme", code: "X" },
    { sku: "B-2", vendor: "", code: "Y" },
  ]);
  const rows = rowsFromJsonText(json, { keyColumn: ["sku", "vendor"], truthColumn: "code" });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].keys, ["A-1", "Acme"]);
  assert.equal(rows[0].truth, "X");
});

test("the CLI joins on a composite key end to end", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [
    "dist/cli.js", "scan", "--json",
    "--left", "examples/countries_ui.csv", "--left-key", "country,iso3",
    "--right", "examples/countries_reference.csv", "--right-key", "country,iso3",
  ], { cwd: new URL("..", import.meta.url).pathname, maxBuffer: 16 * 1024 * 1024 });

  const report = JSON.parse(stdout);
  assert.deepEqual(report.keyComponents, ["country", "iso3"], "--left-key names the components");
  const full = report.agreement.find((b) => b.full);
  assert.equal(full.leftRows, report.recovered);
  const partial = report.agreement.find((b) => !b.full && b.labels.join() === "iso3");
  assert.ok(partial.leftRows > 0, "the ISO code agrees where the country name does not");
  assert.equal(
    report.agreement.reduce((n, b) => n + b.leftRows, 0),
    report.leftRows - report.exactMatches,
  );
});

// --- identifying versus blocking ---------------------------------------------

test("a bucket says whether its components identify a row or merely block", () => {
  // iso3-style: the agreeing component picks out exactly one right row.
  const identifies = scan(
    [C("1", ["Bosnia", "BIH"])],
    [C("a", ["Bosnia and Herzegovina", "BIH"]), C("b", ["Bolivia", "BOL"])],
    { keyLabels: ["country", "iso3"] },
  );
  const iso = bucket(identifies, ["iso3"]);
  assert.equal(iso.maxCandidates, 1);
  assert.ok(
    identifies.warnings.some((w) => w.includes("identifies a row on its own") && w.includes("re-run keyed on iso3")),
    "a component that identifies is worth measuring as a key on its own",
  );

  // city-style: half the table shares the value, so these are not pairs.
  const blocks = scan(
    Array.from({ length: 6 }, (_, i) => C(`l${i}`, [`Left Co ${i}`, i % 2 ? "Boston" : "Chicago"])),
    Array.from({ length: 6 }, (_, i) => C(`r${i}`, [`Right Co ${i}`, i % 2 ? "Boston" : "Chicago"])),
    NAME_CITY,
  );
  const city = bucket(blocks, ["city"]);
  assert.equal(city.leftRows, 6);
  assert.equal(city.maxCandidates, 3, "three right rows share each city");
  assert.ok(
    blocks.warnings.some((w) => w.includes("blocks rather than identifies")),
    "and shadowjoin must not suggest joining on it",
  );
  assert.ok(!blocks.warnings.some((w) => w.includes("re-run keyed on city")));
});

test("a bucket's ground truth is capped rather than overstated on a huge candidate set", () => {
  // 60 right rows share the city, past the 50-row verification cap. Claiming
  // "all of them agree" or "none do" would be a claim the sample cannot make.
  const left = [C("1", ["Acme", "Boston"], "A1")];
  const right = Array.from({ length: 60 }, (_, i) => C(`r${i}`, [`Co ${i}`, "Boston"], "A1"));
  const r = scan(left, right, NAME_CITY);
  const city = bucket(r, ["city"]);
  assert.equal(city.maxCandidates, 60);
  assert.equal(city.verified, 0, "a truncated sample must not report a verified pair");
  assert.equal(city.ambiguous, 1);
  assert.equal(r.recovered, 0, "and none of it touches the floor");
});
