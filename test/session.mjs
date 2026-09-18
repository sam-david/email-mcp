import { spawn } from "node:child_process";
const PORT = 8802, BASE = `http://127.0.0.1:${PORT}`, BEARER = "sess-test";
const srv = spawn(process.execPath, ["src/index.mjs"], {
  env: { ...process.env, PORT: String(PORT), MCP_BEARER_TOKEN: BEARER, MAIL_EMAIL: "x@example.com", MAIL_PASSWORD: "y", MAIL_ENV_FILE: "", MAIL_PROFILE: "" },
  stdio: "ignore",
});
process.on("exit", () => srv.kill());
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

let fail = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const H = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${BEARER}` };
const post = (body, extra = {}) => fetch(`${BASE}/mcp`, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(body) });

// 1. no session header, not an initialize -> 400 (spec: Session Management 2)
const noSess = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
check("no session id -> 400", noSess.status === 400, `got ${noSess.status}`);

// 2. UNKNOWN session id -> 404 (spec: Session Management 3; client MUST re-init)
const bogus = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-session-id": "00000000-dead-beef-0000-000000000000" });
check("unknown session id -> 404", bogus.status === 404, `got ${bogus.status}`);
check("404 body tells the client to re-initialize", (await bogus.text()).includes("initialize"));

// 3. a real session works
const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const sid = init.headers.get("mcp-session-id");
check("initialize returns a session id", Boolean(sid), sid || "none");
await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid });
check("valid session id works", tools.status === 200, `got ${tools.status}`);

// 4. GET/DELETE follow the same rule
const getBogus = await fetch(`${BASE}/mcp`, { method: "GET", headers: { ...H, "mcp-session-id": "11111111-dead-beef-0000-000000000000" } });
check("GET with unknown session -> 404", getBogus.status === 404, `got ${getBogus.status}`);
const getNone = await fetch(`${BASE}/mcp`, { method: "GET", headers: H });
check("GET with no session -> 400", getNone.status === 400, `got ${getNone.status}`);

srv.kill();
console.log(fail ? `\n${fail} FAILURE(S)` : "\nall checks passed");
process.exit(fail ? 1 : 0);
