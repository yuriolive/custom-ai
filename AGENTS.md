# AGENTS.md

Entry point for coding agents (Codex, Cursor, opencode, Copilot, Jules, …).
Claude Code reads `CLAUDE.md`; everything below applies to every agent.

## 1. Prime the issue tracker first

**IMPORTANT: before you do anything else, run the `beans prime` command and heed its
output.** This repo tracks work with [beans](https://github.com/hmans/beans) — Markdown
issues in `.beans/`, committed alongside the code. `beans prime` prints the current
contract for creating, updating, and completing them. Use beans instead of any built-in
todo-list tool; a todo list dies with the context window, a bean does not.

Not installed? `brew install hmans/beans/beans` or
`go install github.com/hmans/beans@latest`. Claude Code runs `beans prime` automatically
via the `SessionStart` and `PreCompact` hooks in `.claude/settings.json`; opencode users
can copy `beans-prime.ts` from the beans repo into `.opencode/plugin/`. Every other agent
runs it by hand.

## 2. Then read `CLAUDE.md`

`CLAUDE.md` is the single source of project guidance: what this is, the frozen contracts,
the layout, the commands, and the non-obvious invariants (integer micro-USD money, the
two GPU tier catalogs that must agree, why the endpoint ref is load-bearing). It is not
Claude-specific — read it as `AGENTS.md`'s body.

Docs referenced there, in the order they matter: `docs/CONTRACTS.md` (frozen),
`docs/PRD-inference-marketplace-mvp.md`, `docs/HANDOFF.md`, `docs/DEPLOY.md`,
`docs/ROADMAP.md`.

## 3. Before claiming a change is done

```bash
npm run check   # env + oxlint + eslint + typecheck across all 5 tsconfigs
npm test        # node --test across app, hf-probe, gateway, mock-upstream, keygen, adapter
```

Money or billing touched? The pgTAP suite under `supabase/tests/` is the authority — a
money change that does not touch it is incomplete. Python worker: `cd tools/modal && uv run pytest`.

## 4. Two rules that are cheap to break silently

- **One owner per path.** The ownership table is in `docs/CONTRACTS.md`. `.beans/` is the
  one shared, everyone-writes path.
- **Secrets are server-only.** Nothing secret is ever prefixed `NEXT_PUBLIC_`, and no API
  key, HF token, or bearer header is ever logged.
