#!/usr/bin/env node
/**
 * teardown.js — delete a provisioned endpoint, then its template (FR-DEP-037).
 *
 * Order matters and is not negotiable: deleteEndpoint FIRST. A template still referenced
 * by a live endpoint cannot be deleted, and deleting the template first (if RunPod ever
 * allowed it) would leave an endpoint whose container spec has vanished.
 *
 * Safe to run repeatedly:
 *   - a resource already gone (null id, or RunPod says "not found") is treated as SUCCESS
 *   - the state entry is only removed once BOTH resources are confirmed gone
 *   - a failure to delete the endpoint never removes the template id from state, because
 *     that id is the only remaining handle on a billable resource
 *
 * This tool does NOT touch the Vault secret or the custom_models row — those live in
 * supabase/ and are owned elsewhere. FR-DEP-037's other two steps belong to that owner.
 */

import {
  RunpodError,
  graphql,
  materializeForReview,
  redact,
  resolveApiKey,
  resolveGraphqlUrl,
} from "./runpod-client.js";
import {
  getResource,
  loadState,
  removeResource,
  resolveStateFile,
  upsertResource,
} from "./state.js";
import { parseArgs } from "./provision.js";

export const DELETE_ENDPOINT_MUTATION = `
mutation DeleteEndpoint($id: String!) {
  deleteEndpoint(id: $id)
}`;

export const DELETE_TEMPLATE_MUTATION = `
mutation DeleteTemplate($templateName: String!) {
  deleteTemplate(templateName: $templateName)
}`;

/** RunPod reports an already-deleted resource as an error; that is a SUCCESS for us. */
function isAlreadyGone(err) {
  const t = `${err?.message ?? ""} ${JSON.stringify(err?.graphqlErrors ?? [])}`.toLowerCase();
  return /not found|does not exist|no such|invalid endpoint id|unknown template/.test(t);
}

/**
 * @param {string} key resource key from the state file
 * @param {{dryRun?:boolean,url?:string,apiKey?:string,stateFile?:string,fetchImpl?:typeof fetch,log?:(s:string)=>void}} opts
 */
export async function teardown(key, opts = {}) {
  const { dryRun = false, url, stateFile, fetchImpl, log = () => {} } = opts;
  const graphqlUrl = resolveGraphqlUrl(url);

  const record = await getResource(key, stateFile);
  if (!record) {
    // Idempotent: nothing recorded means nothing of ours to delete.
    log(`[teardown] no state entry for '${key}' — nothing to do`);
    return { ok: true, key, endpoint: "absent", template: "absent", noop: true };
  }

  const apiKey = opts.apiKey ?? resolveApiKey({ required: !dryRun });

  const steps = [];
  if (record.runpod_endpoint_id) {
    steps.push({
      operationName: "DeleteEndpoint",
      query: DELETE_ENDPOINT_MUTATION,
      variables: { id: record.runpod_endpoint_id },
    });
  }
  if (record.templateName) {
    steps.push({
      operationName: "DeleteTemplate",
      query: DELETE_TEMPLATE_MUTATION,
      variables: { templateName: record.templateName },
    });
  }

  if (dryRun) {
    const lines = ["─".repeat(78), "DRY RUN — nothing was sent to RunPod, nothing deleted.", "─".repeat(78)];
    lines.push(`  GraphQL URL   : ${graphqlUrl}`);
    lines.push(`  RUNPOD_API_KEY: ${process.env.RUNPOD_API_KEY ? "present (value redacted — never printed)" : "ABSENT (fine for a dry run)"}`);
    lines.push(`  state file    : ${resolveStateFile(stateFile)}`);
    lines.push(`  resource key  : ${key}`);
    lines.push(`  endpoint      : ${record.runpod_endpoint_id ?? "(none recorded)"}`);
    lines.push(`  template      : ${record.runpod_template_id ?? "(none recorded)"} / ${record.templateName ?? "(no name)"}`);
    if (steps.length === 0) lines.push("\n  Nothing to delete.");
    for (const s of steps) {
      lines.push("", `── ${s.operationName} ${"─".repeat(Math.max(0, 74 - s.operationName.length))}`);
      lines.push(materializeForReview(s.query, s.variables));
    }
    lines.push("─".repeat(78));
    log(lines.join("\n"));
    return { ok: true, dryRun: true, key, steps };
  }

  const result = { ok: true, key, endpoint: "absent", template: "absent" };

  // ── 1. deleteEndpoint ──────────────────────────────────────────────────────
  if (record.runpod_endpoint_id) {
    try {
      await graphql({
        url: graphqlUrl, apiKey, query: DELETE_ENDPOINT_MUTATION,
        variables: { id: record.runpod_endpoint_id }, operationName: "DeleteEndpoint", fetchImpl,
      });
      result.endpoint = "deleted";
      log(`[teardown] endpoint ${record.runpod_endpoint_id} deleted`);
    } catch (err) {
      if (isAlreadyGone(err)) {
        result.endpoint = "already_gone";
        log(`[teardown] endpoint ${record.runpod_endpoint_id} already gone — treating as success`);
      } else {
        // Keep the ids in state. They are the only handle on a live billable resource.
        await upsertResource(key, {
          status: "delete_failed",
          runpod_error: { code: err.code, message: err.message },
          remediation_hint: err.remediation ?? null,
        }, stateFile);
        throw err;
      }
    }
    // Endpoint gone: drop its id so a re-run does not retry a dead handle, but keep the
    // template id — it is still live and still billable-adjacent.
    await upsertResource(key, { runpod_endpoint_id: null, status: "endpoint_deleted" }, stateFile);
  }

  // ── 2. deleteTemplate ──────────────────────────────────────────────────────
  if (record.templateName) {
    try {
      await graphql({
        url: graphqlUrl, apiKey, query: DELETE_TEMPLATE_MUTATION,
        variables: { templateName: record.templateName }, operationName: "DeleteTemplate", fetchImpl,
      });
      result.template = "deleted";
      log(`[teardown] template ${record.templateName} deleted`);
    } catch (err) {
      if (isAlreadyGone(err)) {
        result.template = "already_gone";
        log(`[teardown] template ${record.templateName} already gone — treating as success`);
      } else {
        await upsertResource(key, {
          status: "delete_failed",
          runpod_error: { code: err.code, message: err.message },
          remediation_hint: err.remediation ?? null,
        }, stateFile);
        throw err;
      }
    }
  }

  // Both confirmed gone — only now is it safe to forget the record.
  await removeResource(key, stateFile);
  log(`[teardown] state entry '${key}' removed`);
  return result;
}

/** Tear down every recorded resource. Continues past failures and reports them all. */
export async function teardownAll(opts = {}) {
  const state = await loadState(opts.stateFile);
  const keys = Object.keys(state.resources);
  const results = [];
  for (const key of keys) {
    try {
      results.push(await teardown(key, opts));
    } catch (err) {
      results.push({ ok: false, key, code: err.code, message: redact(err.message), remediation: err.remediation });
    }
  }
  return { ok: results.every((r) => r.ok), count: keys.length, results };
}

const USAGE = `
runpod-teardown — deleteEndpoint then deleteTemplate (FR-DEP-037). Safe to re-run.

  node tools/runpod/teardown.js --key KEY [--dry-run]
  node tools/runpod/teardown.js --all [--dry-run]
  node tools/runpod/teardown.js --list

  --key KEY    resource key from the state file
  --all        tear down every recorded resource
  --list       list recorded resources and exit
  --state FILE state file; default $RUNPOD_STATE_FILE or tools/runpod/.state/runpod-state.json
  --url URL    GraphQL base; default $RUNPOD_GRAPHQL_URL
  --dry-run    print the exact payloads and exit. Sends nothing.
  --json       machine-readable result

RUNPOD_API_KEY is read from the environment only.
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) { process.stdout.write(USAGE); return 0; }
  const stateFile = args.state ? String(args.state) : undefined;

  try {
    if (args.list) {
      const state = await loadState(stateFile);
      const rows = Object.values(state.resources);
      if (!rows.length) process.stdout.write("No recorded RunPod resources.\n");
      for (const r of rows) {
        process.stdout.write(
          `${r.key}  ${r.status ?? "?"}\n  endpoint ${r.runpod_endpoint_id ?? "-"}\n  template ${r.runpod_template_id ?? "-"} (${r.templateName ?? "-"})\n  ${r.hfRepoSlug ?? "?"} / ${r.modelFile ?? "?"}\n`,
        );
      }
      return 0;
    }

    const opts = {
      dryRun: Boolean(args.dryRun),
      url: args.url ? String(args.url) : undefined,
      stateFile,
      log: (s) => process.stdout.write(s + "\n"),
    };

    const result = args.all
      ? await teardownAll(opts)
      : args.key
        ? await teardown(String(args.key), opts)
        : (() => { throw new RunpodError("Pass --key KEY or --all (or --list).", { code: "invalid_args" }); })();

    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`\n[FAILED] ${err.code ?? "error"}: ${redact(err.message)}\n`);
    if (err.remediation) process.stderr.write(`\n  ${redact(err.remediation)}\n`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("teardown.js")) {
  main().then((c) => { process.exitCode = c; });
}
