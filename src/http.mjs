// HTTP transport: serves the MCP server over Streamable HTTP with bearer auth.
//
//   • Single mode (local / no SECRETS_PREFIX): one mailbox from the env/profile
//     (resolveConfig) + MCP_BEARER_TOKEN, served at /mcp.
//   • Multi-tenant mode (SECRETS_PREFIX set, i.e. cloud): the URL path selects
//     the profile — POST /<profile> (or /<profile>/mcp) — and each profile's
//     creds + bearer come from its own Secrets Manager secret.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
import { secretsMode, getProfile } from "./secrets.mjs";

const jsonErr = (res, status, code, message) => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

// "/dva/mcp" -> "dva", "/mcp" -> "", "/dva" -> "dva"
function profileFromPath(url) {
  return url.split("?")[0].replace(/\/mcp\/?$/, "").replace(/^\/+|\/+$/g, "");
}

export function startHttp() {
  const PORT = Number(process.env.PORT || 8787);
  const multi = secretsMode();

  // Single-mode config resolved once at startup.
  let single = null;
  if (!multi) {
    const { cfg, source } = resolveConfig();
    single = { cfg, source, bearer: process.env.MCP_BEARER_TOKEN || "" };
  }

  const transports = {}; // sessionId -> transport

  // Resolve { cfg, bearer, source } for a request, or null (→ 404).
  async function resolve(req) {
    if (!multi) return single;
    const profile = profileFromPath(req.url);
    if (!profile) return null;
    try {
      return await getProfile(profile);
    } catch {
      return null;
    }
  }

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("email-mcp ok");
      return;
    }

    const ctx = await resolve(req);
    if (!ctx) return jsonErr(res, 404, -32004, "Unknown mailbox profile.");

    // Bearer auth (per-profile in multi-tenant mode).
    if (ctx.bearer) {
      if ((req.headers["authorization"] || "") !== `Bearer ${ctx.bearer}`) {
        return jsonErr(res, 401, -32001, "Unauthorized");
      }
    } else if (multi) {
      return jsonErr(res, 500, -32002, "Profile has no bearer token configured.");
    }

    const sessionId = req.headers["mcp-session-id"];
    try {
      if (req.method === "POST") {
        const body = await readJson(req);
        let transport = sessionId ? transports[sessionId] : undefined;
        if (!transport && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => { transports[sid] = transport; },
          });
          transport.onclose = () => {
            if (transport.sessionId) delete transports[transport.sessionId];
          };
          await createServer(ctx.cfg, ctx.source).connect(transport);
        } else if (!transport) {
          return jsonErr(res, 400, -32000, "No valid session; send an initialize request first.");
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports[sessionId] : undefined;
        if (!transport) return jsonErr(res, 400, -32000, "Unknown or missing session id.");
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(405);
      res.end();
    } catch (e) {
      jsonErr(res, 400, -32700, String(e?.message || e));
    }
  });

  httpServer.listen(PORT, () => {
    console.error(
      `email-mcp HTTP on :${PORT} — ${multi ? "MULTI-TENANT (path → profile → Secrets Manager)" : "single mode"}`
    );
  });

  return httpServer;
}
