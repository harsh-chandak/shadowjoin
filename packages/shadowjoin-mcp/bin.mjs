#!/usr/bin/env node
// The whole package. Importing the subpath starts the server — dist/mcp.js
// connects a StdioServerTransport on load, so there is nothing to call and
// nothing to forward: this process IS the server, with stdio already wired.
//
// A child process would mean proxying stdin/stdout, and stdout is the protocol
// channel: anything that buffers, re-chunks or interleaves it corrupts framing.
import "shadowjoin/mcp";
