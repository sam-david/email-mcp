// HTTP transport: serves the MCP server over Streamable HTTP.
//
//   • Single mode (local / no SECRETS_PREFIX): one mailbox from the env/profile
//     (resolveConfig) + MCP_BEARER_TOKEN, served at /mcp.
//   • Multi-tenant mode (SECRETS_PREFIX set, i.e. cloud): the URL path selects
//     the profile — POST /<profile> (or /<profile>/mcp) — and each profile's
//     creds + bearer come from its own Secrets Manager secret.
//
// Two ways to authenticate, both checked against the same per-profile bearer:
//   • the static bearer itself — Claude Code (--header) and the Messages API
//     MCP connector (authorization_token);
//   • an OAuth 2.1 access token this server issued — claude.ai Connectors,
//     whose UI has no header field and requires the full discovery flow.
//     See oauth.mjs.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
import { secretsMode, getProfile } from "./secrets.mjs";
import * as oauth from "./oauth.mjs";

const jsonErr = (res, status, code, message, headers = {}) => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
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

// A request is authorized if it carries either the profile's static bearer or
// an unexpired OAuth access token this server minted for that profile.
function authorized(req, bearer, profile) {
  const header = String(req.headers["authorization"] || "");
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  return oauth.safeEq(token, bearer) || Boolean(oauth.verifyAccessToken(token, bearer, profile));
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

    // OAuth discovery + flow endpoints come first: the MCP router below would
    // otherwise read "/authorize" or "/.well-known/..." as a mailbox name.
    const oauthRoute = oauth.matchOAuth(req.url.split("?")[0]);
    if (oauthRoute) {
      if (multi !== Boolean(oauthRoute.profile)) {
        // Multi-tenant URLs must name a profile; single-mode URLs must not.
        return jsonErr(res, 404, -32004, "Unknown mailbox profile.");
      }
      let octx = null;
      try {
        octx = oauthRoute.profile ? await getProfile(oauthRoute.profile) : single;
      } catch {
        // Metadata documents are public and describe the URL space, so they
        // answer even for a profile that doesn't exist; anything that has to
        // sign or verify needs the real bearer and is refused below.
        octx = null;
      }
      try {
        if (await oauth.handle(req, res, { ...oauthRoute, ctx: octx }) !== false) return;
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_request", error_description: String(e?.message || e) }));
        }
        return;
      }
    }

    const ctx = await resolve(req);
    if (!ctx) return jsonErr(res, 404, -32004, "Unknown mailbox profile.");

    // Bearer auth (per-profile in multi-tenant mode). The 401 carries a
    // WWW-Authenticate pointing at this profile's protected-resource metadata,
    // which is what lets a claude.ai connector bootstrap the OAuth flow.
    const profile = multi ? profileFromPath(req.url) : "";
    if (ctx.bearer) {
      if (!authorized(req, ctx.bearer, profile)) {
        return jsonErr(res, 401, -32001, "Unauthorized", {
          "www-authenticate": oauth.challenge(req, profile),
        });
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

  // Bind 0.0.0.0 explicitly (IPv4) so container health checks reach it, and log
  // to stdout so platform log capture sees it.
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(
      `email-mcp HTTP on 0.0.0.0:${PORT} — ${multi ? "MULTI-TENANT (path → profile → Secrets Manager)" : "single mode"}`
    );
  });

  return httpServer;
}
