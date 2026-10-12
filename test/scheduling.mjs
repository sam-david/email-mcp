// Guards the failure that lost 13 scheduled sends on 2026-09-21: profileName()
// fell back to "default", every local stdio schedule was queued against a
// secret that has never existed, and the send died inside a Lambda hours later
// with nothing visible to the caller.
//
// A schedule that cannot succeed must be refused at schedule time.
//
//   npm run test:scheduling
import { spawn } from "node:child_process";

let failures = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); if (!ok) failures++; };

async function scheduleWith(env) {
  const proc = spawn(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      MAIL_EMAIL: "x@example.com", MAIL_PASSWORD: "y",
      MAIL_ENV_FILE: "", MAIL_PROFILE: "",
      // Fake-but-present so schedulingOn() passes and we reach the guard.
      WORKER_LAMBDA_ARN: "arn:aws:lambda:us-east-1:000000000000:function:fake",
      SCHEDULER_ROLE_ARN: "arn:aws:iam::000000000000:role/fake",
      ...env,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = ""; const pending = new Map(); let id = 0;
  proc.stdout.on("data", d => { buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } } catch {} } });
  const rpc = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const when = new Date(Date.now() + 3600e3).toISOString();
  const r = await rpc("tools/call", { name: "schedule_send", arguments: {
    to: "nobody@example.com", subject: "guard", body: "guard", send_at: when } });
  proc.kill();
  return r?.result?.content?.[0]?.text ?? JSON.stringify(r);
}

// 1. Nothing names a profile -> must refuse, and must NOT invent "default".
const noProfile = await scheduleWith({});
check("unnamed profile is refused", /cannot tell which mailbox/i.test(noProfile), noProfile.split("\n")[0]);
check("does not silently use \"default\"", !/emailmcp-default-/.test(noProfile) && !/Scheduled ✓/.test(noProfile));
check("refusal says how to fix it", /MAIL_PROFILE/.test(noProfile));

// 2. A named profile whose secret does not exist -> must refuse before queueing.
const badProfile = await scheduleWith({ MAIL_PROFILE: "definitely-not-a-real-profile" });
check("nonexistent secret is refused", /refusing to schedule/i.test(badProfile), badProfile.split("\n")[0]);
check("refusal names the secret the worker would need", /email-mcp\/definitely-not-a-real-profile/.test(badProfile));
check("nothing was queued", !/Scheduled ✓/.test(badProfile));

// 3. A check that cannot RUN must not block the send. Simulating the live
// failure: the deployment's role grants GetSecretValue but not DescribeSecret,
// so the guard got AccessDenied for a secret it reads fine on every request —
// and refused every scheduled send. Only a genuine absence may block.
{
  const { secretResolves } = await import("../src/secrets.mjs");
  const real = await secretResolves("definitely-not-a-real-profile");
  check("a missing secret is reported missing", real.missing === true, JSON.stringify(real));

  // Force a non-ResourceNotFound error by pointing at an unreachable endpoint.
  const prevRegion = process.env.AWS_REGION;
  process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER = "http://127.0.0.1:1";
  const mod = await import("../src/secrets.mjs?nocache=" + Date.now());
  const unreachable = await mod.secretResolves("dva");
  delete process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER;
  if (prevRegion) process.env.AWS_REGION = prevRegion;
  check("an unverifiable check does NOT block", unreachable.ok === true && unreachable.unverified === true, JSON.stringify(unreachable).slice(0, 120));
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
