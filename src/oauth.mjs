// OAuth 2.1 authorization server — so claude.ai Connectors can add this server.
//
// Claude Code and the Messages API MCP connector can send a static bearer
// (--header / authorization_token), but the claude.ai connector UI has no
// header field: it hits the URL, expects a 401 carrying WWW-Authenticate, and
// walks RFC 9728 -> RFC 8414 -> RFC 7591 -> PKCE. This module is that walk.
//
// Everything is scoped to one mailbox profile, so the issuer is per-profile:
//   resource / issuer   https://host/<profile>
//   metadata            /.well-known/oauth-protected-resource/<profile>
//                       /.well-known/oauth-authorization-server/<profile>
//   endpoints           /<profile>/{register,authorize,token}
// (In local single-mode the profile segment is absent: /authorize, etc.)
//
// NO SERVER STATE. Client registrations, auth codes and tokens are all HMAC
// blobs signed with a key derived from that profile's bearer token:
//   key = HMAC-SHA256(bearer, "email-mcp/oauth/v1")
// which means no new secret to store, nothing to lose across container
// restarts or extra App Runner instances, per-profile isolation for free, and
// rotating a mailbox's bearer instantly invalidates every token issued for it.
//
// The consent step asks for that same bearer — you paste it once per connector.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const SCOPE = "mailbox";

// The authorization-request parameters. The consent form re-submits all of
// them, so this list is the single source of truth for what survives the
// GET -> user approval -> POST round trip.
const AUTH_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
];
const CODE_TTL = 300; // 5 min
const ACCESS_TTL = 8 * 3600; // 8 h
const REFRESH_TTL = 60 * 86400; // 60 d
const CLIENT_TTL = 10 * 365 * 86400; // effectively non-expiring

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const now = () => Math.floor(Date.now() / 1000);

// Constant-time string compare that tolerates length mismatch.
export function safeEq(a, b) {
  const A = Buffer.from(String(a ?? ""));
  const B = Buffer.from(String(b ?? ""));
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
}

const keyFor = (bearer) =>
  createHmac("sha256", String(bearer)).update("email-mcp/oauth/v1").digest();

function sign(payload, bearer) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(createHmac("sha256", keyFor(bearer)).update(body).digest())}`;
}

// Verify signature, type and expiry. Returns the payload or null.
function open(token, bearer, typ) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", keyFor(bearer)).update(body).digest();
  const got = unb64u(mac);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p;
  try {
    p = JSON.parse(unb64u(body).toString("utf8"));
  } catch {
    return null;
  }
  if (p.typ !== typ || !p.exp || p.exp <= now()) return null;
  return p;
}

// An access token minted by this server for this profile. Distinct bearers
// already give each profile a distinct signing key, but bind the profile into
// the check too so two mailboxes that were handed the same bearer by mistake
// still can't borrow each other's tokens.
export function verifyAccessToken(token, bearer, profile = "") {
  const p = open(token, bearer, "at");
  return p && p.p === profile ? p : null;
}

// ---------------------------------------------------------------- helpers
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Every metadata document advertises absolute URLs, so the scheme has to be
// right or the client silently fails. Behind App Runner's proxy TLS is
// terminated upstream and x-forwarded-proto is set; assume https otherwise
// (any real deployment is https) except on loopback, where local dev is plain
// http. PUBLIC_BASE_URL overrides all of it.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const host = String(req.headers.host || "");
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  const proto = String(req.headers["x-forwarded-proto"] || (loopback ? "http" : "https"))
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

// Canonical resource / issuer URI for a profile (RFC 8707 §2, no trailing slash).
const resourceUri = (req, profile) => `${baseUrl(req)}${profile ? `/${profile}` : ""}`;

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
};

const html = (res, status, body) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req) {
  const raw = await readBody(req);
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Redirect back to the client with either a success or an error payload.
function redirect(res, redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  res.writeHead(302, { location: u.toString(), "cache-control": "no-store" });
  res.end();
}

// Only https, or http on loopback (MCP Inspector / Claude Code local callbacks).
function validRedirectUri(u) {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 401 challenge
// Point the client at this profile's protected-resource metadata (RFC 9728),
// which is the entire reason claude.ai can bootstrap the flow.
export function challenge(req, profile) {
  const url = `${baseUrl(req)}/.well-known/oauth-protected-resource${profile ? `/${profile}` : ""}`;
  return `Bearer resource_metadata="${url}", scope="${SCOPE}"`;
}

// ---------------------------------------------------------------- routing
// Recognise an OAuth path, splitting off the profile segment. Must run before
// the MCP path router, which would otherwise read "authorize" as a mailbox.
export function matchOAuth(pathname) {
  let m = /^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(?:\/(.*?))?\/?$/.exec(pathname);
  if (m) return { endpoint: m[1], profile: m[2] || "" };

  // Path-suffixed form some clients try: /<profile>/.well-known/<doc>
  m = /^(?:\/(.+?))?\/\.well-known\/(oauth-authorization-server|openid-configuration)\/?$/.exec(pathname);
  if (m) return { endpoint: m[2], profile: m[1] || "" };

  m = /^(?:\/(.+?))?\/(register|authorize|token)\/?$/.exec(pathname);
  if (m) return { endpoint: m[2], profile: m[1] || "" };

  return null;
}

// ---------------------------------------------------------------- consent page
function consentPage({ profile, clientName, params, error }) {
  // Every authorization parameter must round-trip through the form: on POST the
  // browser sends these hidden fields and nothing else, so anything omitted
  // here reads as absent and fails validation. Omitting response_type made the
  // approval redirect back with unsupported_response_type instead of a code.
  const hidden = AUTH_PARAMS.map((k) => (params[k] ? `<input type="hidden" name="${k}" value="${esc(params[k])}">` : "")).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize email-mcp</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText;
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(92vw,26rem);padding:2rem;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px}
h1{margin:0 0 .25rem;font-size:1.1rem}
p{margin:.25rem 0 1.25rem;color:color-mix(in srgb,CanvasText 65%,transparent)}
code{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
label{display:block;font-weight:600;font-size:.85rem;margin-bottom:.4rem}
input[type=password]{width:100%;box-sizing:border-box;padding:.6rem .7rem;font:inherit;border-radius:8px;
border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:Canvas;color:CanvasText}
.row{display:flex;gap:.6rem;margin-top:1.25rem}
button{flex:1;padding:.6rem;font:inherit;font-weight:600;border-radius:8px;cursor:pointer;
border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:transparent;color:CanvasText}
button[value=allow]{background:CanvasText;color:Canvas;border-color:CanvasText}
.err{margin:0 0 1rem;padding:.6rem .7rem;border-radius:8px;font-size:.85rem;
background:color-mix(in srgb,#d33 15%,transparent);color:CanvasText}
</style></head><body><form class="card" method="post">
<h1>Authorize access to your mailbox</h1>
<p><strong>${esc(clientName || "An MCP client")}</strong> is requesting access to the
<code>${esc(profile || "default")}</code> mailbox — reading and sending email.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${hidden}
<label for="t">Mailbox access token</label>
<input id="t" name="access_token" type="password" autocomplete="off" autofocus
 placeholder="the bearer token for this profile">
<div class="row">
  <button type="submit" name="decision" value="deny">Deny</button>
  <button type="submit" name="decision" value="allow">Authorize</button>
</div>
</form></body></html>`;
}

// ---------------------------------------------------------------- endpoints
//
// handle() returns true if it owned the request. `ctx` is the resolved profile
// ({ cfg, bearer, source }); a profile with no bearer can't sign anything, so
// OAuth is simply off for it.
export async function handle(req, res, { endpoint, profile, ctx }) {
  const iss = resourceUri(req, profile);

  if (endpoint === "oauth-protected-resource") {
    return json(res, 200, {
      resource: iss,
      authorization_servers: [iss],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: `email-mcp (${profile || "default"})`,
    });
  }

  if (endpoint === "oauth-authorization-server" || endpoint === "openid-configuration") {
    return json(res, 200, {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      registration_endpoint: `${iss}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    });
  }

  if (!ctx?.bearer) {
    return json(res, 503, { error: "temporarily_unavailable", error_description: "OAuth is not configured for this mailbox." });
  }

  // ---- RFC 7591 dynamic client registration ----
  // We store nothing: the client_id *is* the signed registration.
  if (endpoint === "register") {
    if (req.method !== "POST") return json(res, 405, { error: "invalid_request" });
    const body = await readForm(req);
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || !uris.every(validRedirectUri)) {
      return json(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be present and https (http allowed on loopback only).",
      });
    }
    const client_id = sign(
      { typ: "client", p: profile, ru: uris, n: String(body.client_name || "").slice(0, 120), exp: now() + CLIENT_TTL },
      ctx.bearer
    );
    return json(res, 201, {
      client_id,
      client_id_issued_at: now(),
      redirect_uris: uris,
      client_name: body.client_name,
      token_endpoint_auth_method: "none", // public client; PKCE is the protection
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    });
  }

  // ---- authorization endpoint ----
  if (endpoint === "authorize") {
    const params =
      req.method === "POST"
        ? await readForm(req)
        : Object.fromEntries(new URL(req.url, iss).searchParams);

    const client = open(params.client_id, ctx.bearer, "client");
    // Before we trust a redirect_uri we must trust the client, so these two
    // failures render rather than redirect (open-redirect protection).
    if (!client) return html(res, 400, errorPage("Unknown or expired client registration."));

    const redirectUri = params.redirect_uri || (client.ru.length === 1 ? client.ru[0] : "");
    if (!redirectUri || !client.ru.includes(redirectUri)) {
      return html(res, 400, errorPage("The redirect_uri does not match this client's registration."));
    }

    const fail = (error, error_description) =>
      redirect(res, redirectUri, { error, error_description, state: params.state, iss });

    if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (params.code_challenge_method !== "S256" || !params.code_challenge) {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }

    if (req.method === "GET") {
      return html(res, 200, consentPage({ profile, clientName: client.n, params }));
    }
    if (req.method !== "POST") return json(res, 405, { error: "invalid_request" });

    if (params.decision !== "allow") return fail("access_denied", "The request was denied.");
    if (!safeEq(params.access_token, ctx.bearer)) {
      return html(res, 401, consentPage({ profile, clientName: client.n, params, error: "That token doesn't match this mailbox. Try again." }));
    }

    const code = sign(
      { typ: "code", p: profile, ci: params.client_id, ru: redirectUri, cc: params.code_challenge, exp: now() + CODE_TTL },
      ctx.bearer
    );
    return redirect(res, redirectUri, { code, state: params.state, iss });
  }

  // ---- token endpoint ----
  if (endpoint === "token") {
    if (req.method !== "POST") return json(res, 405, { error: "invalid_request" });
    const body = await readForm(req);
    const grant = body.grant_type;

    const issueTokens = () => {
      const claims = { p: profile, aud: iss, ci: body.client_id };
      return json(res, 200, {
        access_token: sign({ ...claims, typ: "at", exp: now() + ACCESS_TTL }, ctx.bearer),
        token_type: "Bearer",
        expires_in: ACCESS_TTL,
        refresh_token: sign({ ...claims, typ: "rt", exp: now() + REFRESH_TTL }, ctx.bearer),
        scope: SCOPE,
      });
    };

    if (grant === "authorization_code") {
      const code = open(body.code, ctx.bearer, "code");
      if (!code) return json(res, 400, { error: "invalid_grant", error_description: "Authorization code is invalid or expired." });
      if (body.client_id && code.ci !== body.client_id) {
        return json(res, 400, { error: "invalid_grant", error_description: "Code was issued to a different client." });
      }
      if (body.redirect_uri && code.ru !== body.redirect_uri) {
        return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri does not match the authorization request." });
      }
      const challengeFromVerifier = b64u(createHash("sha256").update(String(body.code_verifier || "")).digest());
      if (!safeEq(challengeFromVerifier, code.cc)) {
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
      }
      body.client_id = body.client_id || code.ci;
      return issueTokens();
    }

    if (grant === "refresh_token") {
      const rt = open(body.refresh_token, ctx.bearer, "rt");
      if (!rt) return json(res, 400, { error: "invalid_grant", error_description: "Refresh token is invalid or expired." });
      body.client_id = body.client_id || rt.ci;
      return issueTokens();
    }

    return json(res, 400, { error: "unsupported_grant_type" });
  }

  return false;
}

function errorPage(msg) {
  return `<!doctype html><meta charset="utf-8"><title>Authorization error</title>
<body style="font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem">
<h1 style="font-size:1.1rem">Authorization error</h1><p>${esc(msg)}</p></body>`;
}
