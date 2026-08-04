#!/usr/bin/env node
// email-mcp — a minimal MCP server for reading and sending email over any
// IMAP/SMTP account (Zoho, Gmail, Fastmail, custom).
//
// Two transports:
//   • stdio (default) — Claude Code launches it as a local subprocess.
//   • HTTP  (MCP_HTTP=1 or PORT set) — Streamable HTTP + bearer token, for
//     remote hosting so cloud/scheduled agents can reach it.
//
// Credentials come ONLY from the environment or an external profile/env file —
// never from inside this repo. Connects ONLY to the configured mail hosts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
import { startHttp } from "./http.mjs";

const httpMode =
  process.env.MCP_HTTP === "1" ||
  process.env.MCP_HTTP === "true" ||
  Boolean(process.env.PORT);

if (httpMode) {
  startHttp();
} else {
  const { cfg, source } = resolveConfig();
  // Over stdio the server is a subprocess on the user's own machine, so
  // attachments may be read from / written to local paths. The HTTP transport
  // deliberately does not enable this — see attachments.mjs.
  await createServer(cfg, source, { allowLocalFiles: true }).connect(new StdioServerTransport());
}
