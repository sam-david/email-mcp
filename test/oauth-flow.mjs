// Drives the whole OAuth 2.1 dance against email-mcp exactly as a claude.ai
// connector does: 401 -> protected-resource metadata -> AS metadata -> dynamic
// client registration -> PKCE authorize/token -> authenticated MCP call.
// Also covers the refusals (bad PKCE, unregistered redirect_uri, wrong token)
// and checks the static-bearer path still works.
//
//   npm test        — spawns the server on a scratch port and tears it down
//   BASE=https://mcp.example.com/dva MCP_BEARER_TOKEN=... node test/oauth-flow.mjs
//                   — run against a live deployment instead
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 8799;
const BEARER = process.env.MCP_BEARER_TOKEN || "test-bearer-local-only";
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const b64u = (b) => Buffer.from(b).toString("base64url");

// Spawn our own server unless we were pointed at one.
let child = null;
if (!process.env.BASE) {
  child = spawn(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT, MCP_BEARER_TOKEN: BEARER, MAIL_EMAIL: "test@example.com", MAIL_PASSWORD: "unused" },
    stdio: "ignore",
  });
  process.on("exit", () => child?.kill());
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/health`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. unauthenticated MCP request must 401 WITH a discovery pointer
const unauth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
const wwwAuth = unauth.headers.get("www-authenticate");
check("401 on unauthenticated request", unauth.status === 401, `status ${unauth.status}`);
check("401 carries WWW-Authenticate", Boolean(wwwAuth), wwwAuth || "header absent");

// 2. protected resource metadata (RFC 9728), discovered from that header
const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth || "")?.[1];
check("WWW-Authenticate advertises resource_metadata", Boolean(prmUrl), prmUrl);
const prm = await (await fetch(prmUrl)).json();
check("PRM names the resource", Boolean(prm.resource), prm.resource);
check("PRM names an authorization server", Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0);

// 3. authorization server metadata (RFC 8414)
const issuer = prm.authorization_servers[0];
const asmUrl = `${new URL(issuer).origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname === "/" ? "" : new URL(issuer).pathname}`;
const asm = await (await fetch(asmUrl)).json();
check("ASM issuer matches PRM", asm.issuer === issuer, `${asm.issuer} vs ${issuer}`);
check("ASM requires S256 PKCE", asm.code_challenge_methods_supported?.includes("S256"));
check("ASM advertises registration_endpoint", Boolean(asm.registration_endpoint), asm.registration_endpoint);

// 4. dynamic client registration (RFC 7591) — as claude.ai does
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const regRes = await fetch(asm.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"] }),
});
const reg = await regRes.json();
check("DCR returns 201", regRes.status === 201, `status ${regRes.status}`);
check("DCR issues a client_id", Boolean(reg.client_id));

// a non-https redirect_uri must be rejected
const badReg = await fetch(asm.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Evil", redirect_uris: ["http://evil.example.com/cb"] }),
});
check("DCR rejects non-loopback http redirect_uri", badReg.status === 400, `status ${badReg.status}`);

// 5. authorize — PKCE
const verifier = b64u(randomBytes(32));
const challenge = b64u(createHash("sha256").update(verifier).digest());
const authParams = new URLSearchParams({
  response_type: "code",
  client_id: reg.client_id,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "xyz-state",
  scope: "mailbox",
  resource: prm.resource,
});

const consent = await fetch(`${asm.authorization_endpoint}?${authParams}`);
const consentHtml = await consent.text();
check("GET /authorize renders a consent page", consent.status === 200 && consentHtml.includes("Authorize"), `status ${consent.status}`);

// Submit exactly what the rendered form submits — NOT a body rebuilt from the
// original params. A browser posts the hidden fields and nothing else, so any
// parameter the page fails to round-trip is missing on POST. Rebuilding the
// body here once hid a real bug: response_type was absent from the form, and
// every approval redirected back with unsupported_response_type.
const formFields = Object.fromEntries(
  [...consentHtml.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]])
);
for (const p of ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"]) {
  check(`consent form round-trips ${p}`, formFields[p] === authParams.get(p), `form=${formFields[p]} param=${authParams.get(p)}`);
}
const asBrowser = (extra) => new URLSearchParams({ ...formFields, ...extra });

// wrong token must NOT mint a code
const wrong = await fetch(asm.authorization_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  redirect: "manual",
  body: asBrowser({ decision: "allow", access_token: "not-the-token" }),
});
check("wrong token is rejected", wrong.status === 401 && !wrong.headers.get("location"), `status ${wrong.status}`);

// deny must redirect with access_denied
const denied = await fetch(asm.authorization_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  redirect: "manual",
  body: asBrowser({ decision: "deny", access_token: BEARER }),
});
check("deny redirects with access_denied", new URL(denied.headers.get("location")).searchParams.get("error") === "access_denied");

// tampered redirect_uri must not be honoured (open-redirect guard)
const tampered = await fetch(asm.authorization_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  redirect: "manual",
  body: asBrowser({ redirect_uri: "https://attacker.example/steal", decision: "allow", access_token: BEARER }),
});
check("unregistered redirect_uri is refused", tampered.status === 400 && !tampered.headers.get("location"), `status ${tampered.status}`);

// the real approval
const approved = await fetch(asm.authorization_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  redirect: "manual",
  body: asBrowser({ decision: "allow", access_token: BEARER }),
});
const cb = new URL(approved.headers.get("location"));
const code = cb.searchParams.get("code");
check("approval redirects to the registered callback", cb.origin + cb.pathname === REDIRECT, cb.origin + cb.pathname);
check("approval returns a code", Boolean(code));
check("approval preserves state", cb.searchParams.get("state") === "xyz-state");
check("approval includes iss (RFC 9207)", cb.searchParams.get("iss") === issuer);

// 6. token exchange — wrong verifier must fail
const badTok = await fetch(asm.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: b64u(randomBytes(32)) }),
});
check("PKCE mismatch is rejected", badTok.status === 400, `status ${badTok.status}`);

const tokRes = await fetch(asm.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }),
});
const tok = await tokRes.json();
check("token exchange succeeds", tokRes.status === 200 && Boolean(tok.access_token), JSON.stringify(tok).slice(0, 120));
check("refresh token issued", Boolean(tok.refresh_token));

// 7. the access token actually opens the MCP endpoint
const mcp = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${tok.access_token}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }),
});
const mcpBody = await mcp.text();
check("MCP initialize accepts the OAuth token", mcp.status === 200 && mcpBody.includes("email-mcp"), `status ${mcp.status}`);

// 8. the static bearer still works (Claude Code / Messages API path)
const legacy = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${BEARER}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }),
});
check("static bearer still works (no regression)", legacy.status === 200, `status ${legacy.status}`);

// 9. a forged token signed with a different bearer must be refused
const forged = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer eyJhIjoxfQ.AAAA" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
check("garbage token refused", forged.status === 401, `status ${forged.status}`);

// 10. refresh grant
const refreshed = await fetch(asm.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }),
});
const rtok = await refreshed.json();
check("refresh grant returns a new access token", refreshed.status === 200 && Boolean(rtok.access_token));

// 11. an access token must not be usable as a refresh token, or vice versa
const swap = await fetch(asm.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.access_token, client_id: reg.client_id }),
});
check("access token rejected as refresh token", swap.status === 400, `status ${swap.status}`);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
