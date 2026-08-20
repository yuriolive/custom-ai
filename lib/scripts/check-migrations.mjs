#!/usr/bin/env node
/**
 * Migration filename check. Exits non-zero when `supabase/migrations` holds a
 * file the Supabase CLI cannot apply — or would apply as the wrong thing.
 *
 *   1. Two files sharing a version prefix. `version` is the PRIMARY KEY of
 *      supabase_migrations.schema_migrations, so the second INSERT raises
 *      23505 and `db reset` aborts partway through, taking every open PR red
 *      with it. This has landed twice (0348c2d, then again one number along),
 *      because two branches that never see each other's files cannot detect it
 *      themselves — only a check that reads the whole directory can.
 *
 *   2. A filename the CLI does not recognise as a migration at all. The CLI
 *      wants <14-digit version>_<name>.sql and SILENTLY IGNORES anything else,
 *      so a typo'd prefix means the migration never runs and `db reset`
 *      reports success. Loud beats silent — see docs/HANDOFF.md.
 *
 * Usage: node lib/scripts/check-migrations.mjs
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIR = join(ROOT, "supabase", "migrations");

/** What `supabase migration new` produces, and the only shape the CLI applies. */
const MIGRATION_NAME = /^(\d{14})_([A-Za-z0-9_-]+)\.sql$/;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .toSorted();
const errors = [];
const byVersion = new Map();

for (const file of files) {
  const match = MIGRATION_NAME.exec(file);
  if (!match) {
    errors.push(
      `${file} — not a migration filename. Expected <14-digit version>_<name>.sql; ` +
        `the CLI ignores anything else, so this file would never be applied.`,
    );
    continue;
  }
  const version = match[1];
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(file);
}

for (const [version, group] of byVersion) {
  if (group.length > 1) {
    errors.push(
      `duplicate version ${version}: ${group.join(", ")} — ` +
        `schema_migrations.version is a PRIMARY KEY, so applying the second one ` +
        `raises 23505 and aborts the migration run. Renumber all but one.`,
    );
  }
}

if (errors.length > 0) {
  console.error("\ncheck:migrations FAILED\n");
  for (const e of errors) {
    console.error(`  x ${e}`);
    // Also emit a GitHub annotation so the failure lands on the Actions summary.
    if (process.env.GITHUB_ACTIONS) console.error(`::error::${e}`);
  }
  console.error(`\n${errors.length} problem(s) in supabase/migrations.\n`);
  process.exit(1);
}

console.log(`check:migrations OK — ${files.length} migration(s), no duplicate versions.`);
