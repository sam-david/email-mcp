// Attachment handling: the resolver's rules and limits, plus an end-to-end
// dry-run send through the real stdio server to prove the tool schema and
// preview carry attachments.
//
//   npm run test:attachments
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveAttachments, MAX_ONE, MAX_SCHEDULED_TOTAL } from "../src/attachments.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Assert the call rejects, and that the message actually explains why.
async function rejects(name, fn, mustMention) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    const msg = String(e.message || e);
    check(name, msg.toLowerCase().includes(mustMention.toLowerCase()), msg.slice(0, 110));
  }
}

const dir = await mkdtemp(join(tmpdir(), "email-mcp-test-"));
const filePath = join(dir, "report.csv");
await writeFile(filePath, "name,count\nalice,3\nbob,5\n");

// ---- byte sources ----
const local = await resolveAttachments([{ path: filePath }], { allowLocalFiles: true });
check("local path attaches, filename inferred", local[0]?.filename === "report.csv", local[0]?.filename);
check("local path reads real bytes", local[0]?.content.toString().startsWith("name,count"));

const renamed = await resolveAttachments([{ path: filePath, filename: "Q3.csv" }], { allowLocalFiles: true });
check("explicit filename overrides the basename", renamed[0]?.filename === "Q3.csv");

const inline = await resolveAttachments(
  [{ filename: "hello.txt", content_base64: Buffer.from("hi there").toString("base64") }],
  { allowLocalFiles: false }
);
check("content_base64 works without local files", inline[0]?.content.toString() === "hi there");

// ---- the remote-safety gate: this is the important one ----
await rejects(
  "path is REFUSED when local files are disabled (remote)",
  () => resolveAttachments([{ path: filePath }], { allowLocalFiles: false }),
  "runs locally over stdio"
);
await rejects(
  "path refusal names the alternatives",
  () => resolveAttachments([{ path: "/etc/passwd" }], { allowLocalFiles: false }),
  "content_base64"
);

// ---- malformed specs ----
await rejects(
  "no byte source is rejected",
  () => resolveAttachments([{ filename: "x.txt" }], { allowLocalFiles: true }),
  "exactly one"
);
await rejects(
  "two byte sources are rejected",
  () => resolveAttachments([{ path: filePath, content_base64: "aGk=" }], { allowLocalFiles: true }),
  "exactly one"
);
await rejects(
  "content_base64 without a filename is rejected",
  () => resolveAttachments([{ content_base64: "aGk=" }], { allowLocalFiles: true }),
  "filename is required"
);
await rejects(
  "missing file gives a readable error",
  () => resolveAttachments([{ path: join(dir, "nope.pdf") }], { allowLocalFiles: true }),
  "no such file"
);
await rejects(
  "a directory is not a file",
  () => resolveAttachments([{ path: dir }], { allowLocalFiles: true }),
  "not a file"
);
await rejects(
  "from_uid needs an IMAP connection",
  () => resolveAttachments([{ from_uid: 42 }], { allowLocalFiles: true, withImap: null }),
  "not available"
);

// ---- limits ----
const big = join(dir, "big.bin");
await writeFile(big, Buffer.alloc(MAX_ONE + 1024));
await rejects(
  "per-file limit is enforced",
  () => resolveAttachments([{ path: big }], { allowLocalFiles: true }),
  "per-file limit"
);

const oneHundredK = Buffer.alloc(100 * 1024).toString("base64");
await rejects(
  "scheduled-send budget is enforced separately",
  () =>
    resolveAttachments(
      [
        { filename: "a.bin", content_base64: oneHundredK },
        { filename: "b.bin", content_base64: oneHundredK },
      ],
      { allowLocalFiles: false, maxTotal: MAX_SCHEDULED_TOTAL }
    ),
  "EventBridge Scheduler"
);
const underBudget = await resolveAttachments([{ filename: "a.bin", content_base64: oneHundredK }], {
  maxTotal: MAX_SCHEDULED_TOTAL,
});
check("a small scheduled attachment is allowed", underBudget.length === 1);

// ---- the resolved shape must produce a real MIME part ----
// Compose the message nodemailer would put on the wire, without SMTP, and look
// for the attachment part rather than trusting that the call didn't throw.
{
  const nodemailer = (await import("nodemailer")).default;
  const composed = await nodemailer
    .createTransport({ streamTransport: true, buffer: true })
    .sendMail({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Report",
      text: "See attached.",
      attachments: await resolveAttachments([{ path: filePath }], { allowLocalFiles: true }),
    });
  const mime = composed.message.toString();
  check("MIME is multipart", /Content-Type: multipart\/mixed/i.test(mime));
  check("MIME declares the attachment filename", /Content-Disposition: attachment; filename="?report\.csv"?/i.test(mime), mime.match(/Content-Disposition:.*/i)?.[0]);
  check("MIME declares text/csv", /Content-Type: text\/csv/i.test(mime));
  check(
    "MIME carries the file's actual bytes",
    mime.includes(Buffer.from("name,count\nalice,3\nbob,5\n").toString("base64").slice(0, 24))
  );
}

// ---- end-to-end through the real stdio server (dry-run, nothing is sent) ----
async function callTool(name, args, env = {}) {
  const proc = spawn(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      MAIL_ENV_FILE: "",
      MAIL_PROFILE: "",
      MAIL_EMAIL: "test@example.com",
      MAIL_PASSWORD: "unused",
      MAIL_DRY_RUN: "true", // never sends
      ...env,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n"
  );
  let out = "";
  for await (const chunk of proc.stdout) {
    out += chunk;
    if (out.includes('"id":2')) break;
  }
  proc.kill();
  const line = out.split("\n").find((l) => l.includes('"id":2'));
  return JSON.parse(line).result?.content?.[0]?.text || JSON.stringify(JSON.parse(line));
}

const sent = await callTool("send_email", {
  to: "someone@example.com",
  subject: "Report",
  body: "See attached.",
  attachments: [{ path: filePath }],
});
check("stdio send_email accepts attachments", sent.includes("DRY RUN"), sent.split("\n")[0]);
check("preview lists the attachment", sent.includes("report.csv"), sent.split("\n").find((l) => l.includes("report.csv")) || sent.slice(0, 80));
check("preview shows attachment count", /Attachments \(1\)/.test(sent));
check("preview reports the real MIME type, not octet-stream", sent.includes("text/csv"));

// The same call over HTTP must refuse the local path rather than reading the
// server's disk for a remote caller.
const remote = await callTool(
  "send_email",
  { to: "someone@example.com", subject: "Report", body: "See attached.", attachments: [{ path: filePath }] },
  { MCP_HTTP: "" } // stdio here; the HTTP refusal is covered by the resolver checks above
);
check("stdio still allows the local path", remote.includes("report.csv"));

await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
