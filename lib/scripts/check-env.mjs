#!/usr/bin/env node
/**
 * CI-style environment safety check. Exits non-zero — and therefore fails
 * `npm run build` — when either invariant from CONTRACTS.md is violated:
 *
 *   1. A secret-shaped name or a secret-shaped VALUE appears in a
 *      NEXT_PUBLIC_* variable. NEXT_PUBLIC_* is inlined into the browser
 *      bundle at build time; anything placed there is public forever.
 *   2. A server-only variable is referenced from a "use client" module.
 *
 * Usage: node lib/scripts/check-env.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Files scanned for env declarations, in addition to the real process env. */
const ENV_FILES = [
  ".env.example",
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

/** Source trees owned by the frontend scaffold. */
const SOURCE_DIRS = ["app", "components", "lib"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Variable NAMES that mean "credential". A NEXT_PUBLIC_ variable whose name
 * matches any of these is rejected regardless of its value.
 */
const SECRET_NAME_PATTERNS = [
  /SERVICE_ROLE/i,
  /SECRET/i,
  /PRIVATE/i,
  /PASSWORD/i,
  /PASSPHRASE/i,
  /CREDENTIAL/i,
  /_TOKEN$/i,
  /API_KEY$/i,
  /ACCESS_KEY/i,
  /SIGNING/i,
  /WEBHOOK/i,
];

/**
 * Names that look secret-shaped but are publishable by design. Keep this list
 * short and justify every entry.
 */
const NAME_ALLOWLIST = new Set([
  // Supabase anon key is a publishable JWT; it is powerless without RLS.
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
]);

/**
 * Variable VALUES that look like a live credential, whatever the name says.
 */
const SECRET_VALUE_PATTERNS = [
  { re: /^sk-[A-Za-z0-9_-]{8,}/, what: "OpenAI-style / platform secret key (sk-…)" },
  { re: /^sk_(live|test)_[A-Za-z0-9]{8,}/, what: "Stripe secret key (sk_live_/sk_test_…)" },
  { re: /^rk_(live|test)_[A-Za-z0-9]{8,}/, what: "Stripe restricted key" },
  { re: /^whsec_[A-Za-z0-9]{8,}/, what: "Stripe webhook signing secret" },
  { re: /^rpa_[A-Za-z0-9]{8,}/, what: "RunPod API key (rpa_…)" },
  { re: /^hf_[A-Za-z0-9]{8,}/, what: "Hugging Face token (hf_…)" },
  { re: /^gh[pousr]_[A-Za-z0-9]{16,}/, what: "GitHub token" },
  { re: /^xox[baprs]-[A-Za-z0-9-]{8,}/, what: "Slack token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "PEM private key" },
  { re: /"?role"?\s*:\s*"?service_role/, what: "service_role JWT claim" },
];

/** A JWT whose payload decodes to a service_role claim. */
function isServiceRoleJwt(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return /"role"\s*:\s*"service_role"/.test(payload);
  } catch {
    return false;
  }
}

/** Placeholder values in .env.example must not trip the entropy heuristic. */
function isPlaceholder(value) {
  if (value === "") return true;
  if (/^(replace|your|changeme|todo|xxx|<)/i.test(value)) return true;
  if (/^(replace-with-|your-|example|placeholder)/i.test(value)) return true;
  return false;
}

/** High-entropy blob: 40+ chars of unbroken base64/hex with no scheme or dots. */
function looksHighEntropy(value) {
  if (value.length < 40) return false;
  if (/^https?:\/\//.test(value)) return false;
  if (value.includes(" ") || value.includes("/")) return false;
  return /^[A-Za-z0-9+_=-]{40,}$/.test(value);
}

const errors = [];
const scanned = [];

// ---------------------------------------------------------------------------
// 1. NEXT_PUBLIC_* must never carry a secret
// ---------------------------------------------------------------------------

/** Minimal dotenv parser — no dependency, no evaluation. */
function parseEnvFile(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const name = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ name, value, line: i + 1 });
  });
  return out;
}

function checkPair(name, value, origin) {
  if (!name.startsWith("NEXT_PUBLIC_")) return;
  if (NAME_ALLOWLIST.has(name)) return;

  for (const re of SECRET_NAME_PATTERNS) {
    if (re.test(name)) {
      errors.push(
        `${origin}: ${name} — a NEXT_PUBLIC_ variable must not be named like a credential ` +
          `(matched ${re}). NEXT_PUBLIC_ is inlined into the browser bundle.`,
      );
      return;
    }
  }

  if (isPlaceholder(value)) return;

  for (const { re, what } of SECRET_VALUE_PATTERNS) {
    if (re.test(value)) {
      errors.push(`${origin}: ${name} — value looks like a ${what}. Never ship that to the browser.`);
      return;
    }
  }

  if (isServiceRoleJwt(value)) {
    errors.push(`${origin}: ${name} — value is a JWT carrying a service_role claim.`);
    return;
  }

  if (looksHighEntropy(value)) {
    errors.push(
      `${origin}: ${name} — value is a ${value.length}-char high-entropy blob, which reads as a ` +
        `credential. If it is genuinely public, add it to NAME_ALLOWLIST with a reason.`,
    );
  }
}

for (const file of ENV_FILES) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  scanned.push(file);
  for (const { name, value, line } of parseEnvFile(readFileSync(path, "utf8"))) {
    checkPair(name, value, `${file}:${line}`);
  }
}

for (const [name, value] of Object.entries(process.env)) {
  checkPair(name, value ?? "", "process.env");
}

// ---------------------------------------------------------------------------
// 2. Server-only variables must not be referenced from client components
// ---------------------------------------------------------------------------

/** Every non-NEXT_PUBLIC_ name declared in .env.example is server-only. */
const serverOnlyNames = new Set();
const examplePath = join(ROOT, ".env.example");
if (existsSync(examplePath)) {
  for (const { name } of parseEnvFile(readFileSync(examplePath, "utf8"))) {
    if (!name.startsWith("NEXT_PUBLIC_")) serverOnlyNames.add(name);
  }
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (SOURCE_EXT.test(entry)) acc.push(full);
  }
  return acc;
}

const sourceFiles = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  if (!/^\s*["']use client["']/m.test(text)) continue;
  const rel = relative(ROOT, file).split(sep).join("/");
  for (const name of serverOnlyNames) {
    const re = new RegExp(`process\\.env\\.${name}\\b|process\\.env\\[["']${name}["']\\]`);
    if (re.test(text)) {
      errors.push(
        `${rel}: reads server-only ${name} from a "use client" module. ` +
          `Move the read into a server component or a route handler.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error("\ncheck:env FAILED\n");
  for (const e of errors) console.error(`  x ${e}`);
  console.error(`\n${errors.length} problem(s). See CONTRACTS.md §Environment.\n`);
  process.exit(1);
}

console.log(
  `check:env OK — scanned ${scanned.length ? scanned.join(", ") : "no env files"}, ` +
    `${sourceFiles.length} source file(s), ${serverOnlyNames.size} server-only variable(s).`,
);
