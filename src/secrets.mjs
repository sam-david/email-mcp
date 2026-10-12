// Multi-tenant config: resolve a mailbox profile at request time.
//
// Cloud (SECRETS_PREFIX set): each profile is one AWS Secrets Manager secret
//   named `<prefix><profile>` (e.g. "email-mcp/dva") whose JSON holds the mail
//   creds AND that profile's bearer token:
//     { "email","password","fromName","fromAddress","imapHost","smtpHost",
//       "imapPort","smtpPort","dryRun","bearer" }
//   Add an inbox = add a secret + register a connector at /<profile>. No redeploy.
//
// Local (no SECRETS_PREFIX): single-profile mode is used instead (see http.mjs);
// this module is inert.
import { SecretsManagerClient, GetSecretValueCommand, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";

const PREFIX = process.env.SECRETS_PREFIX || "";
const client = PREFIX ? new SecretsManagerClient({}) : null;

// small TTL cache so we don't hit Secrets Manager on every request
const cache = new Map(); // profile -> { value, expires }
const TTL_MS = 60_000;

export function secretsMode() {
  return Boolean(PREFIX);
}

function toConfig(j) {
  return {
    cfg: {
      email: j.email,
      pass: j.password,
      fromName: j.fromName || "",
      fromAddress: j.fromAddress || j.email,
      imapHost: j.imapHost || "imap.zoho.com",
      imapPort: Number(j.imapPort || 993),
      smtpHost: j.smtpHost || "smtp.zoho.com",
      smtpPort: Number(j.smtpPort || 465),
      dryRun: String(j.dryRun ?? "true").toLowerCase() !== "false",
    },
    bearer: j.bearer || "",
  };
}

// Returns { cfg, bearer, source } for a profile, or throws if the secret is
// missing. Only valid profile names (a-z0-9_-) are accepted.
export async function getProfile(profile) {
  if (!/^[a-z0-9_-]+$/i.test(profile)) throw new Error("invalid profile");
  const now = Date.now();
  const hit = cache.get(profile);
  if (hit && hit.expires > now) return hit.value;

  const secretId = `${PREFIX}${profile}`;
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const parsed = toConfig(JSON.parse(out.SecretString || "{}"));
  const value = { ...parsed, source: `secretsmanager:${secretId}` };
  cache.set(profile, { value, expires: now + TTL_MS });
  return value;
}

// The prefix the WORKER will use when it fires. Locally SECRETS_PREFIX is unset
// (this module is otherwise inert), but a scheduled send is executed in the
// cloud, so the name it will look up is still email-mcp/<profile>.
export const workerSecretId = (profile) => `${PREFIX || "email-mcp/"}${profile}`;

// Does the secret a scheduled send will need actually exist? Checked before
// queueing, because the failure otherwise happens hours later inside a Lambda
// where the caller never sees it. DescribeSecret, not GetSecretValue: we only
// need existence, not the credentials.
export async function secretResolves(profile) {
  const SecretId = workerSecretId(profile);
  const c = client || new SecretsManagerClient({});
  try {
    await c.send(new DescribeSecretCommand({ SecretId }));
    return { ok: true, SecretId };
  } catch (e) {
    const name = e?.name || String(e?.message || e);
    // ONLY a genuine absence is evidence the send cannot succeed. Anything
    // else -- no DescribeSecret permission, throttling, a network blip --
    // means the check could not run, which says nothing about the secret.
    // Blocking on those turns a diagnostic into an outage: this refused every
    // scheduled send on the live deployment, whose role grants GetSecretValue
    // but not DescribeSecret, for a secret it reads successfully on every
    // request.
    if (name === "ResourceNotFoundException") return { ok: false, missing: true, SecretId, reason: name };
    return { ok: true, unverified: true, SecretId, reason: name };
  }
}
