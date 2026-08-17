#!/usr/bin/env node
/**
 * Standalone runner for the mock RunPod upstream.
 *
 *   node tools/mock-upstream/cli.js --port 8787
 *   node tools/mock-upstream/cli.js --port 8787 --usage none --cold-start-ms 3000 --quiet
 *
 * Any control from CONTROLS can be given as a --kebab-case flag to change the
 * server-wide default (per-request headers/query params still win).
 */
import { startMockUpstream, CONTROLS } from "./index.js";

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const FLAG_TO_CONTROL = Object.fromEntries(Object.keys(CONTROLS).map((k) => [kebab(k), k]));

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`mock-upstream — fake RunPod OpenAI-compatible serverless endpoint

Usage: node cli.js [--port N] [--host H] [--quiet] [control flags]

Route: POST /v2/:endpointId/openai/v1/chat/completions

Control flags (also settable per-request; see README):
${Object.entries(CONTROLS)
  .map(([name, s]) => `  --${kebab(name).padEnd(18)} header ${s.header.padEnd(26)} query ${s.query.padEnd(18)} default ${JSON.stringify(s.def)}`)
  .join("\n")}
`);
  process.exit(0);
}

const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  if (key === "quiet") { args.quiet = true; continue; }
  const control = CONTROLS[FLAG_TO_CONTROL[key]];
  const next = argv[i + 1];
  // boolean controls may be given bare: `--honor-include-usage`
  if (control?.kind === "bool" && (next === undefined || next.startsWith("--"))) {
    args[key] = "true";
    continue;
  }
  args[key] = next;
  i++;
}

const defaults = {};
for (const [flag, control] of Object.entries(FLAG_TO_CONTROL)) {
  if (args[flag] !== undefined) defaults[control] = args[flag];
}

const port = Number(args.port ?? process.env.MOCK_UPSTREAM_PORT ?? 8787);
const host = args.host ?? "127.0.0.1";

const mock = await startMockUpstream({ port, host, defaults, log: !args.quiet });

console.log(`mock-upstream listening on ${mock.url}`);
console.log(`  POST ${mock.url}/v2/{endpointId}/openai/v1/chat/completions`);
console.log(`  defaults: ${JSON.stringify(mock.getDefaults())}`);

const stop = async () => {
  await mock.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
