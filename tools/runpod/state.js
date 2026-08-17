/**
 * state.js — the local record of live, billable RunPod resources.
 *
 * FR-DEP-033: runpod_template_id and runpod_endpoint_id are persisted IMMEDIATELY on
 * creation, BEFORE any smoke test, so a failed smoke test still leaves a deletable,
 * non-orphaned resource. That requirement is why every write here is a durable
 * write-temp-then-rename: a half-written state file would orphan a live GPU endpoint.
 *
 * SECURITY: RUNPOD_API_KEY never enters this file. Every record passes through
 * redactObject() on the way in.
 */

import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { redactObject } from "./runpod-client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE_FILE = path.join(HERE, ".state", "runpod-state.json");

export const STATE_VERSION = 1;

/** Resolve the state file path. Env override so tests never touch the real one. */
export function resolveStateFile(explicit) {
  return explicit || process.env.RUNPOD_STATE_FILE || DEFAULT_STATE_FILE;
}

/**
 * The idempotency key. Deterministic from the model's IDENTITY — repo, revision and the
 * specific variant file — deliberately NOT from its tuning (context, parallel, tier).
 * Re-provisioning the same model with a longer context must UPDATE the existing template
 * rather than create a second one; keying on config would orphan the first (FR-DEP-030).
 */
export function resourceKey(spec) {
  const identity = [spec.hfRepoSlug, spec.hfRevision ?? "main", spec.modelFile].join("\x00");
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** `nexus-tpl-{key}` — the deterministic name provisioning reconciles against. */
export function templateName(spec) {
  return `nexus-tpl-${resourceKey(spec)}`;
}

/** `nexus-{creator_handle}-{model_slug}` (PRD §4.3.4), falling back to the repo path. */
export function endpointName(spec) {
  const slugify = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const [owner, repo] = spec.hfRepoSlug.split("/");
  const creator = slugify(spec.creatorHandle ?? owner);
  const model = slugify(spec.modelSlug ?? repo);
  return `nexus-${creator}-${model}`;
}

function emptyState() {
  return { version: STATE_VERSION, updatedAt: null, resources: {} };
}

export async function loadState(file) {
  const target = resolveStateFile(file);
  if (!existsSync(target)) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(target, "utf8"));
    if (parsed?.version !== STATE_VERSION) {
      throw new Error(`state file version ${parsed?.version} is not ${STATE_VERSION}`);
    }
    parsed.resources ??= {};
    return parsed;
  } catch (err) {
    // Never silently start from empty: that is exactly how a live endpoint is orphaned.
    throw new Error(
      `Refusing to continue: state file ${target} is unreadable (${err.message}). ` +
        `It may reference live billable RunPod resources. Inspect or move it manually before re-running.`,
    );
  }
}

/** Durable write: temp file, then atomic rename. */
export async function saveState(state, file) {
  const target = resolveStateFile(file);
  await mkdir(path.dirname(target), { recursive: true });
  state.version = STATE_VERSION;
  state.updatedAt = new Date().toISOString();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(redactObject(state), null, 2) + "\n", "utf8");
  await rename(tmp, target);
  return target;
}

/**
 * Merge a partial record for `key` and flush to disk in one durable step.
 * Callers use this the instant an id comes back from RunPod — not after a batch.
 */
export async function upsertResource(key, patch, file) {
  const state = await loadState(file);
  const now = new Date().toISOString();
  const prev = state.resources[key] ?? { key, createdAt: now };
  state.resources[key] = { ...prev, ...patch, key, updatedAt: now };
  await saveState(state, file);
  return state.resources[key];
}

export async function getResource(key, file) {
  const state = await loadState(file);
  return state.resources[key] ?? null;
}

export async function removeResource(key, file) {
  const state = await loadState(file);
  delete state.resources[key];
  await saveState(state, file);
}

export async function deleteStateFile(file) {
  const target = resolveStateFile(file);
  await rm(target, { force: true });
}
