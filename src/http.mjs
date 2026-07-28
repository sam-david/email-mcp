// HTTP transport: serves the MCP server over Streamable HTTP with a bearer
// token, for remote hosting (behind a persistent container — App Runner /
// Fargate — or any Node host). Local: `MCP_HTTP=1 PORT=8787 node src/index.mjs`.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig } from "./config.mjs";
import { createServer } from "./server.mjs";

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

export function startHttp() {
  const PORT = Number(process.env.PORT || 8787);
  const BEARER = process.env.MCP_BEARER_TOKEN || "";
  const { cfg, source } = resolveConfig();

  // sessionId -> transport (stateful Streamable HTTP)
  const transports = {};

  const httpServer = http.createServer(async (req, res) => {
    // Health check (unauthenticated) — used by load balancers / App Runner.
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("email-mcp ok");
      return;
    }

    // Bearer auth on the MCP endpoint.
    if (BEARER) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${BEARER}`) return jsonErr(res, 401, -32001, "Unauthorized");
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
          await createServer(cfg, source).connect(transport);
        } else if (!transport) {
          return jsonErr(res, 400, -32000, "No valid session; send an initialize request first.");
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      // GET (server->client SSE stream) and DELETE (close session).
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
    const auth = BEARER ? "bearer token required" : "OPEN — set MCP_BEARER_TOKEN!";
    console.error(
      `email-mcp HTTP on :${PORT}  (${auth})  sending as ${cfg.fromAddress || "unset"}  [${source}]`
    );
  });

  return httpServer;
}
