---
# ca-05an
title: GitHub issue forms and PR template
status: completed
type: task
priority: normal
created_at: 2026-08-20T01:51:19Z
updated_at: 2026-08-20T01:54:46Z
---

`.github/` holds only `workflows/`. No issue templates, no PR template, so reports arrive
without the fields that make them actionable here (which surface, whether it reproduces
against local Supabase, `UPSTREAM_PROVIDER`) and PRs arrive without a statement of whether
they touched a monetary path, a frozen contract, or one of the two GPU tier catalogs.

Templates are grounded in `CLAUDE.md`, `docs/CONTRACTS.md` and `.github/workflows/ci.yml`
rather than a generic starter set.

- [x] `.github/ISSUE_TEMPLATE/bug_report.yml` (issue form, not legacy markdown)
- [x] `.github/ISSUE_TEMPLATE/feature_request.yml`
- [x] `.github/ISSUE_TEMPLATE/config.yml`
- [x] `.github/PULL_REQUEST_TEMPLATE.md`
- [x] Validate YAML parses and matches GitHub's issue-form schema (top-level keys, `type` values, unique `id`s)

## Summary of Changes

Four files under `.github/`, on branch `chore/github-issue-pr-templates` off `main`. Not committed;
no PR opened.

- `ISSUE_TEMPLATE/bug_report.yml` — issue form. Required: surface (11 options, tracking the
  layout in CLAUDE.md), what happened + expected, repro steps, where it reproduces (local
  Supabase vs deployment only), and one hygiene checkbox asserting no keys were pasted.
  Optional: `UPSTREAM_PROVIDER`, gateway request details (model id, stream, status +
  `error.code`, txn id), logs, commit.
- `ISSUE_TEMPLATE/feature_request.yml` — surface, what cannot be done today, proposal, an
  optional "does this touch" checkbox set (money path / frozen contract / both tier catalogs /
  migration), MVP-0 relevance, alternatives.
- `ISSUE_TEMPLATE/config.yml` — `blank_issues_enabled: true`, with the reasoning inline. No
  contact links; none exist.
- `PULL_REQUEST_TEMPLATE.md` — the four unconditional gates (`check`, `test`, `build`,
  `format:check`) plus conditional ones keyed to the diff (Python `unittest` + ruff, deno
  check/lint/fmt, pgTAP), then explicit statements on money + pgTAP, frozen-contract
  divergence, migration version collisions, and both GPU tier catalogs.

Validated with a PyYAML script checking top-level keys, element `type` values, per-type
required/allowed attributes, unique `id`s, and dropdown/checkbox option shapes. Labels
`bug` and `enhancement` were confirmed to already exist in the repo. `prettier --check`
passes on all four.
