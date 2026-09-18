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

  // Resolve a request to { ok: true, ctx } or { ok: false, status, code, message }.
  //
  // The failure cases are kept distinct on purpose. Collapsing them all into
  // "Unknown mailbox profile" sent someone debugging in the wrong direction:
  // a URL missing its profile segment, a genuinely unknown profile, and
  // Secrets Manager being unreachable are three different problems, and only
  // the middle one is the client's fault.
  async function resolve(req) {
    if (!multi) return { ok: true, ctx: single };

    const profile = profileFromPath(req.url);
    if (!profile) {
      return {
        ok: false,
        status: 404,
        code: -32004,
        message:
          "This URL is missing its mailbox profile. The connector URL is https://<host>/<profile> — e.g. /dva — not /mcp.",
      };
    }

    try {
      return { ok: true, ctx: await getProfile(profile) };
    } catch (e) {
      const missing = e?.name === "ResourceNotFoundException" || e?.message === "invalid profile";
      if (missing) {
        // Deliberately does not enumerate the valid profiles: this endpoint is
        // unauthenticated and gets swept by scanners looking for exactly that.
        return { ok: false, status: 404, code: -32004, message: `No mailbox profile named "${profile}".` };
      }
      // Anything else -- throttling, IAM, a network blip -- is our problem, not
      // a bad URL, and must not masquerade as one.
      console.log(`profile "${profile}" lookup FAILED: ${e?.name || "Error"}: ${e?.message || e}`);
      return {
        ok: false,
        status: 503,
        code: -32003,
        message: "Mailbox configuration is temporarily unavailable. Retry shortly.",
      };
    }
  }

  const httpServer = http.createServer(async (req, res) => {
    // One line per request to stdout, which App Runner ships to CloudWatch.
    // Path only, never the query string or body: authorization codes, tokens
    // and the consent password travel in those. Without this there is no way
    // to tell a failing OAuth handshake apart from one that never arrived.
    const started = Date.now();
    res.on("finish", () => {
      console.log(`${req.method} ${req.url.split("?")[0]} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });

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

    const resolved = await resolve(req);
    if (!resolved.ok) return jsonErr(res, resolved.status, resolved.code, resolved.message);
    const ctx = resolved.ctx;

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
    // Sessions live in this process's memory, so every container replacement
    // ends all of them. That is survivable ONLY if the client is told to start
    // a new one, and the spec is specific about how (2025-06-18, Session
    // Management 3-4): a request carrying a session id the server does not
    // recognise MUST get 404, and on 404 the client MUST re-initialize.
    // A missing header is the different, genuinely-malformed case and keeps
    // 400 (Session Management 2).
    //
    // This previously answered 400 for both. Clients that retry initialize
    // anyway recovered and the logs showed 400 -> initialize -> ok; clients
    // that follow the spec saw a generic bad-request, never re-initialized,
    // and stayed wedged on a dead session id until reconnected by hand.
    const sessionKey = sessionId ? `${profile}:${sessionId}` : null;
    const gone = () =>
      jsonErr(res, 404, -32001, "Session expired or unknown; send a new initialize request without a session id.");

    try {
      if (req.method === "POST") {
        const body = await readJson(req);
        let transport = sessionKey ? transports[sessionKey] : undefined;
        if (!transport && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            // Key by profile too: a session opened against one mailbox must
            // never resolve against another, even given a guessed id.
            onsessioninitialized: (sid) => { transports[`${profile}:${sid}`] = transport; },
          });
          transport.onclose = () => {
            if (transport.sessionId) delete transports[`${profile}:${transport.sessionId}`];
          };
          await createServer(ctx.cfg, ctx.source).connect(transport);
        } else if (!transport) {
          return sessionId
            ? gone()
            : jsonErr(res, 400, -32000, "No session id; send an initialize request first.");
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionKey ? transports[sessionKey] : undefined;
        if (!transport) {
          return sessionId ? gone() : jsonErr(res, 400, -32000, "Missing session id.");
        }
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
