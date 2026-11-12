import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Two things about the launch declaration that no other test watches, and that
 * fail without telling the author anything: the manifest stays valid JSON and
 * the plugin still installs.
 *
 * Deliberately NOT asserted here: that a userConfig referenced in `env` must be
 * `required: true`. That rule looked certain for a while — the plugin failed to
 * connect, `config_path` was optional, no pluginConfigs entry existed, and the
 * sibling plugin with a REQUIRED config connected on the same host. The
 * falsifying test was a plain host re-dial, which later succeeded with the
 * config still unset. So an unresolvable optional placeholder does not stop the
 * spawn: the host substitutes an empty value (no directory named after the
 * placeholder is ever created, and the server tolerates empty). Asserting it
 * would have frozen a disproved mechanism into the test suite.
 *
 * What the empty value DOES cause is the log landing in whatever directory the
 * server happened to start in — handled where it belongs, by reporting the
 * resolved path, not by making an optional setting mandatory.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));
const manifest = read("../.claude-plugin/plugin.json");
const pkg = read("../package.json");

/** Every ${user_config.X} anywhere in a server's command, args or env. */
function referenced(server) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(server);
  return [...found];
}

test("every userConfig the launch interpolates is actually declared", () => {
  // A key that is merely misspelled resolves to empty rather than erroring, so
  // the server starts and quietly behaves as though nothing was configured.
  const declared = manifest.userConfig ?? {};
  for (const [name, server] of Object.entries(manifest.mcpServers ?? {})) {
    for (const key of referenced(server)) {
      assert.ok(key in declared,
        `mcpServers.${name} interpolates \${user_config.${key}}, which userConfig does not declare. ` +
        `It resolves to empty, so the server starts and silently ignores it.`);
    }
  }
});

test("a launch that points into dist/ needs prepare to build it", () => {
  // dist/ is gitignored and untracked, and the marketplace installs this plugin
  // from GitHub. `npm install` runs `prepare` on a git or local install but not
  // on a published tarball, so this is what makes the launch target exist for
  // marketplace users while npm users keep the prebuilt dist from `files`.
  for (const [name, server] of Object.entries(manifest.mcpServers ?? {})) {
    const script = (server.args ?? []).find((a) => typeof a === "string" && a.endsWith(".js"));
    if (!script?.includes("/dist/")) continue;
    assert.ok(pkg.scripts?.prepare,
      `mcpServers.${name} launches ${script}, but dist/ is gitignored and no prepare script builds it. ` +
      `A marketplace install from GitHub would contain no dist/ at all.`);
  }
});
