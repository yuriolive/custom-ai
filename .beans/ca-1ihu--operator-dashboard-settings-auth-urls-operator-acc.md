---
# ca-1ihu
title: 'Operator dashboard settings: auth URLs + operator account'
status: todo
type: task
priority: critical
created_at: 2026-08-20T00:52:40Z
updated_at: 2026-08-20T00:52:40Z
parent: ca-we5n
---

Operator work in the Supabase dashboard, minutes not hours. First in the
suggested order because sign-up and public access are blocked until it is done.

## Todo
- [ ] Auth URLs — Site URL + Redirect URLs still point at `http://127.0.0.1:3000`; set
      them to `https://custom-ai-one.vercel.app` (the live alias; `custom-ai.vercel.app`
      belongs to an unrelated project, hence the `-one`)
- [ ] Operator account — create in Dashboard → Authentication → Users **with auto-confirm**

## Why auto-confirm
Production email is unconfigured: `enable_confirmations = true` with no
`[auth.email.smtp]` block falls back to Supabase's built-in sender, which is
rate-limited to a few per hour. Auto-confirm sidesteps it entirely for one account.
Real SMTP is still required before any real user signs up.

SSO scope is **not** needed — tested, the production alias serves publicly with no SSO
wall, so no custom domain is required. Previews stay protected.
