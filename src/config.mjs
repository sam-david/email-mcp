// Credential/config resolution. No secrets ever live in this repo.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Load a KEY=VALUE env file into process.env. Existing vars are NOT overridden,
// so the real environment always wins over file values.
export function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const expandHome = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// Build a plain config object from a set of environment variables.
export function configFromEnv(env = process.env) {
  return {
    email: env.MAIL_EMAIL, // login / authenticated account
    pass: env.MAIL_PASSWORD,
    fromName: env.MAIL_FROM_NAME || "",
    // Outgoing From; defaults to the login. Set to a verified alias (e.g. sam@)
    // to send as that identity while still authenticating as MAIL_EMAIL.
    fromAddress: env.MAIL_FROM_ADDRESS || env.MAIL_EMAIL,
    imapHost: env.MAIL_IMAP_HOST || "imap.zoho.com",
    imapPort: Number(env.MAIL_IMAP_PORT || 993),
    smtpHost: env.MAIL_SMTP_HOST || "smtp.zoho.com",
    smtpPort: Number(env.MAIL_SMTP_PORT || 465),
    dryRun: String(env.MAIL_DRY_RUN || "true").toLowerCase() !== "false",
  };
}

// Resolve config from the environment, optionally hydrating from a file first.
// Load order (process env always wins):
//   1. MAIL_ENV_FILE=/path  → load that env file
//   2. MAIL_PROFILE=name    → load ~/.config/email-mcp/<name>.env
//   3. otherwise            → process environment only
export function resolveConfig() {
  let source = "process environment";
  if (process.env.MAIL_ENV_FILE) {
    const p = expandHome(process.env.MAIL_ENV_FILE);
    source = loadEnvFile(p) ? p : `${p} (NOT FOUND)`;
  } else if (process.env.MAIL_PROFILE) {
    const p = join(homedir(), ".config", "email-mcp", `${process.env.MAIL_PROFILE}.env`);
    source = loadEnvFile(p) ? p : `${p} (NOT FOUND)`;
  }
  return { cfg: configFromEnv(), source };
}
