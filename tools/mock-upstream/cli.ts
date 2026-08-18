#!/usr/bin/env node
/**
 * Standalone runner for the mock RunPod upstream.
 *
 *   node tools/mock-upstream/cli.ts --port 8787
 *   node tools/mock-upstream/cli.ts --port 8787 --usage none --cold-start-ms 3000 --quiet
 *
 * Any control from CONTROLS can be given as a --kebab-case flag to change the
 * server-wide default (per-request headers/query params still win).
 */
import { CONTROLS, startMockUpstream } from "./index.ts";
import type { ControlSpec, MockOptions } from "./index.ts";

const kebab = (s: string) => s.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const CONTROL_TABLE = CONTROLS as unknown as Record<string, ControlSpec>;
const FLAG_TO_CONTROL: Record<string, string> = Object.fromEntries(
  Object.keys(CONTROL_TABLE).map((k) => [kebab(k), k]),
);

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`mock-upstream — fake RunPod OpenAI-compatible serverless endpoint

Usage: node cli.ts [--port N] [--host H] [--quiet] [control flags]

Route: POST /v2/:endpointId/openai/v1/chat/completions

Control flags (also settable per-request; see README):
${Object.entries(CONTROL_TABLE)
  .map(
    ([name, s]) =>
      `  --${kebab(name).padEnd(18)} header ${s.header.padEnd(26)} query ${s.query.padEnd(18)} default ${JSON.stringify(s.def)}`,
  )
  .join("\n")}
`);
  process.exit(0);
}

const args: Record<string, string | boolean | undefined> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  if (key === "quiet") {
    args.quiet = true;
    continue;
  }
  const controlName = FLAG_TO_CONTROL[key];
  const control = controlName ? CONTROL_TABLE[controlName] : undefined;
  const next = argv[i + 1];
  // boolean controls may be given bare: `--honor-include-usage`
  if (control?.kind === "bool" && (next === undefined || next.startsWith("--"))) {
    args[key] = "true";
    continue;
  }
  args[key] = next;
  i++;
}

const defaults: Record<string, unknown> = {};
for (const [flag, control] of Object.entries(FLAG_TO_CONTROL)) {
  if (args[flag] !== undefined) defaults[control] = args[flag];
}

const port = Number(args.port ?? process.env.MOCK_UPSTREAM_PORT ?? 8787);
const host = typeof args.host === "string" ? args.host : "127.0.0.1";

const mock = await startMockUpstream({
  port,
  host,
  defaults: defaults as Partial<MockOptions>,
  log: !args.quiet,
});

console.log(`mock-upstream listening on ${mock.url}`);
console.log(`  POST ${mock.url}/v2/{endpointId}/openai/v1/chat/completions`);
console.log(`  defaults: ${JSON.stringify(mock.getDefaults())}`);

const stop = async () => {
  await mock.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
