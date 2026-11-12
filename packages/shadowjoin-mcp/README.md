# shadowjoin-mcp

The [shadowjoin](https://github.com/harsh-chandak/shadowjoin) MCP server,
launchable with no arguments:

```
npx shadowjoin-mcp
```

That is the whole point of this package. `shadowjoin` itself declares two bins
— the CLI and the server — and the CLI is the one whose name matches the
package, so `npx shadowjoin` starts the **CLI**: it prints usage to stdout and
exits. To an MCP host over stdio that is garbage on the protocol channel
followed by a closed stream.

An MCP registry entry names an npm package, and a host runs the bin matching
that name. So the server needs a package whose name *is* the server's bin name.
This is that package: one file, which imports `shadowjoin/mcp`.

It also declares `@modelcontextprotocol/sdk` as a real dependency. `shadowjoin`
keeps it a peer, so running its server bin from a bare install fails on the
missing SDK — which is why the older launch command had to pass
`-p @modelcontextprotocol/sdk` by hand.

## Database sources

`pg` and `mysql2` are deliberately **not** dependencies here. The adapters are
loaded with `await import(...)` only when a scan actually names a Postgres or
MySQL source, so the server starts and serves CSV, JSON and SQLite without
them. Install the driver you need alongside this package:

```
npm i shadowjoin-mcp pg
```

`SHADOWJOIN_CONFIG` points at a config file, if you use one.

## Everything else

Documentation, the CLI, and the skill live in the
[main repository](https://github.com/harsh-chandak/shadowjoin). This package is
a launcher and carries no logic of its own.

## License

MIT
