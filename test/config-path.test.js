import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// REGRESSION: the Claude Code plugin maps SHADOWJOIN_CONFIG to a user
// setting, and an unset setting arrives as an empty string, not as
// undefined. The code used `??`, which only guards null and undefined, so ""
// passed through — and resolve("") is the working DIRECTORY. The default
// install therefore tried to read a directory as its config and told the
// user to create a file at a path that was already a folder.
//
// Read from the built file rather than importing it: dist/mcp.js starts an
// MCP server on import, which would hang the test run.
const built = readFileSync(new URL("../dist/mcp.js", import.meta.url), "utf8");

test("REGRESSION: the config path treats an empty env var as unset", () => {
  assert.match(
    built,
    /process\.env\.SHADOWJOIN_CONFIG\?\.trim\(\) \|\| "shadowjoin\.config\.json"/,
    "an empty SHADOWJOIN_CONFIG must fall back to the default, not resolve to the cwd",
  );
  assert.ok(
    !/process\.env\.SHADOWJOIN_CONFIG \?\? /.test(built),
    "`??` lets an empty string through and is the bug this test exists for",
  );
});

test("the fallback expression resolves a file, never a directory", () => {
  const pick = (v) => resolve(v?.trim() || "shadowjoin.config.json");
  for (const unset of ["", "   ", undefined]) {
    assert.match(pick(unset), /shadowjoin\.config\.json$/,
      `${JSON.stringify(unset)} must resolve to the default config file`);
  }
  assert.equal(pick("/tmp/mine.json"), "/tmp/mine.json", "an explicit path still wins");
});
