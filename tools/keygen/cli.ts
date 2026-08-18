#!/usr/bin/env node
/**
 * keygen — mint, list, and revoke platform API keys (`sk-plat-…`).
 *
 * Runs under Node 24's native type stripping. No build step, no dependencies.
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_SERVICE_ROLE_KEY=...       \
 *   node tools/keygen/cli.ts create --user devcaller --name "laptop"
 *
 * The plaintext key goes to STDOUT and nowhere else; everything else goes to
 * stderr. That split is deliberate — `keygen create … > /dev/null` shows you the
 * banner and the metadata while discarding the credential, and piping stdout into
 * a password manager captures the key and nothing else.
 */

import { createInterface } from "node:readline/promises";
import { PostgrestKeyStore } from "./db.ts";
import { create, list, revoke, CommandError, type Io } from "./commands.ts";
import {
  assertNoSecretsInArgv,
  ConfigError,
  PRODUCTION_FLAG,
  resolveConfig,
  SERVICE_ROLE_ENV,
} from "./config.ts";

const USAGE = `
keygen — platform API key management

  create --user <handle|uuid> --name <label>   Mint a key. Prints the plaintext ONCE.
  list   --user <handle|uuid>                  Show a user's keys (never the hash).
  revoke <key-id|sk-plat-xxxxxxxx> [--yes]     Revoke a key. Prompts unless --yes.

Environment (required, never CLI arguments):
  SUPABASE_URL                 e.g. http://127.0.0.1:54321
  ${SERVICE_ROLE_ENV}   from \`supabase status\`

Flags:
  ${PRODUCTION_FLAG}   Permit a non-local SUPABASE_URL. Think first.
  -h, --help                     This message.

The plaintext key is printed to stdout exactly once and is written nowhere else.
Only its SHA-256 hash is persisted.
`.trimStart();

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgv(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }

  return { command: positional.shift() ?? "", positional, flags };
}

function requireString(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new CommandError(`--${name} is required and needs a value.`);
  }
  return value.trim();
}

const io: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  async confirm(question) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Cannot prompt for confirmation on a non-interactive stdin. " +
          "Re-run in a terminal, or pass --yes if you are certain.\n",
      );
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(question)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  },
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  // Before anything else: make sure no credential was handed to us on the command
  // line, where it is already in the shell history.
  assertNoSecretsInArgv(argv);

  const { command, positional, flags } = parseArgv(argv);
  const cfg = resolveConfig({
    env: process.env,
    allowProduction: flags.get(PRODUCTION_FLAG.slice(2)) === true,
  });

  if (!cfg.isLocal) {
    io.err(`!! Targeting a NON-LOCAL Supabase: ${cfg.url}`);
  }

  const store = new PostgrestKeyStore(cfg.url, cfg.serviceRoleKey);

  switch (command) {
    case "create":
      await create(
        store,
        { user: requireString(flags, "user"), name: requireString(flags, "name") },
        io,
      );
      return 0;

    case "list":
      await list(store, requireString(flags, "user"), io);
      return 0;

    case "revoke": {
      const selector = positional[0] ?? (typeof flags.get("id") === "string" ? String(flags.get("id")) : "");
      if (!selector) throw new CommandError("revoke needs a key id or display prefix.");
      await revoke(store, { selector, yes: flags.get("yes") === true }, io);
      return 0;
    }

    default:
      process.stderr.write(USAGE);
      throw new CommandError(`Unknown command "${command}".`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof CommandError || error instanceof ConfigError) {
    process.stderr.write(`\n${error.message}\n`);
  } else {
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
