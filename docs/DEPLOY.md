# Deploy runbook

Three hosts, and **two native integrations do most of the work** — no GitHub secrets
are involved anywhere.

| Piece | Host | Deployed by |
|---|---|---|
| Postgres, Auth, `gateway` Edge Function | Supabase | **Supabase's GitHub integration**, on merge to the production branch |
| Next.js web app | Vercel | **Vercel's Git integration**, on push |
| llama.cpp inference worker | Modal | `modal deploy` from a workstation |

Supabase alone is not sufficient: it does not host a Next.js SSR app, and this app
cannot be statically exported (`/` is `force-dynamic`, middleware runs per request,
auth uses Server Actions and cookies).

**This repo holds ZERO deploy secrets.** Both integrations authorize via OAuth in
their own dashboards. An earlier revision of the CI workflow had a `deploy-supabase`
job needing three GitHub secrets; it was removed once the integration was in place,
because two systems applying migrations to one database is a race whose failure mode
is a half-applied schema.

---

## Current state

| Thing | State |
|---|---|
| Modal app `nexus-llamacpp` | **deployed**, 0 containers (so $0 idle), proxy auth enforced |
| L4 endpoint | `https://yolive--nexus-llamacpp-llamaserverl4-serve.modal.run` |
| Vercel project | linked — `custom-ai` / `yuri-olives-projects-852572a4` |
| Vercel production env | 17 vars — 14 synced by the Supabase↔Vercel integration, 3 set manually |
| Supabase GitHub integration | connected to `yuriolive/custom-ai` |
| GitHub secrets | **none, by design** |

Still missing: `PLATFORM_API_KEY` (see step 4), Supabase Auth URLs (step 2), and the
merge to `main` that triggers the first deploy (step 3).

---

## 1. Supabase GitHub integration — settings that matter

In **Dashboard → Project Settings → Integrations → GitHub**:

- **Working directory: leave EMPTY.** `supabase/` is at the repository root.
- **Deploy to production: ON**, production branch `main`.

What it applies on merge:

- new migrations
- **Edge Functions declared in `config.toml`**
- Storage buckets declared in `config.toml`

What it ignores: API config, Auth config, and **seed files**.

> ### The `[functions.gateway]` block is load-bearing
>
> `supabase/config.toml` contains:
> ```toml
> [functions.gateway]
> verify_jwt = false
> ```
> It exists because platform API keys (`sk-plat-…`) are opaque tokens, not JWTs, and
> Supabase's platform auth would otherwise reject every OpenAI SDK client with
> `UNAUTHORIZED_INVALID_JWT_FORMAT` before our code runs.
>
> **But the integration only deploys functions that are DECLARED there.** Deleting
> that block would silently stop deploying the gateway altogether — not merely change
> its auth behaviour.

Seed files being ignored is also what keeps the committed fixture API key in
`supabase/seed.sql` out of production. See the warning at the end.

---

## 2. Supabase — two manual settings

### 2a. Function secrets — the integration does not manage these

```
npx supabase secrets set --project-ref gexxzdlppbplfpfqhszf \
  UPSTREAM_PROVIDER=modal \
  UPSTREAM_BASE_URL=https://yolive--nexus-llamacpp-llamaserverl4-serve.modal.run \
  MODAL_KEY=wk-REPLACE \
  MODAL_SECRET=ws-REPLACE
```

Use the **proxy** token pair (`wk-`/`ws-`), not the API token (`ak-`/`as-`): an API
token can deploy and **delete** apps, a proxy token can only invoke.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into deployed functions
automatically — do not set them.

### 2b. Auth URLs — Auth config is NOT deployed by the integration

`config.toml` still has `site_url = "http://127.0.0.1:3000"`, and the integration
ignores Auth config, so this must be set by hand in **Dashboard → Authentication →
URL Configuration**: Site URL and Redirect URLs, both pointing at the Vercel domain.

Left as-is, every confirmation email points at localhost and nobody can complete a
sign-up.

---

## 3. Merge to `main`

```
git checkout main && git merge mvp-0-foundation && git push origin main
```

That single push triggers both integrations: Supabase applies migrations and deploys
the gateway, Vercel builds and deploys the web app.

CI (`node`, `python`, `deno`, `pgtap`) runs on the same push. Consider marking the
Supabase integration's migration check as a **required check** on `main` so a failing
migration blocks the merge rather than reaching production.

---

## 4. `PLATFORM_API_KEY` — after the first deploy, not before

This one is blocked *in principle*: it must be a key minted against the **production**
database, which does not exist until step 3 has run.

```
node tools/keygen/cli.ts create --user <handle> --name "playground" \
  --i-know-this-is-production
vercel env add PLATFORM_API_KEY production
```

Then redeploy the web app so the build picks it up.

---

## Preview/Development credential sync — accepted risk, and its real boundary

Preview and Development sync is **ON**, a deliberate MVP decision to move faster. What
that means precisely, so the trade is understood rather than assumed:

Supabase's own warning is accurate — those environments receive **production
credentials, including the service role key and database password**. The service role
key **bypasses RLS entirely**; the console's own `/api/keys` route uses it for exactly
that reason. So a preview deployment can read and write every user's rows regardless
of who is signed in.

**Verified mitigations already in place** (Vercel defaults, confirmed via
`vercel project protection`):

```json
"ssoProtection": { "deploymentType": "all_except_custom_domains" },
"gitForkProtection": true
```

- **SSO protection** — every preview and development URL requires Vercel authentication.
- **Git fork protection** — a fork PR cannot build a preview carrying these env vars
  without approval. This is the one that matters most, since it closes the path where
  an outsider gets a deployment holding production credentials.

**What auth does NOT fix, and why app-level auth is irrelevant here:** protection
controls who can *reach* the URL. The credential is still present in the preview's
server environment, so anyone on the Vercel team, anything with access to build logs,
or any SSR bug that leaks env can obtain a key that ignores RLS. Adding sign-in
requirements to the app changes nothing, because the service role key is designed to
bypass exactly that.

**Acceptable now, because there is no real user data.** The threshold to revisit is
the first real user: at that point switch to **Supabase Branching**, which gives each
preview branch its own isolated database, and turn Preview/Development sync off.

### ⚠️ Launch trap in that same setting

`deploymentType: "all_except_custom_domains"` protects **every** deployment URL that
is not a custom domain — which includes the production `*.vercel.app` URL. As
configured, the public site will demand a Vercel login.

Two ways out, either is fine:

- attach a **custom domain** to production (previews stay protected, production goes
  public), or
- change the SSO scope to **only preview deployments** in Dashboard → Project →
  Settings → Deployment Protection. The CLI can only toggle SSO on/off, not set the
  scope.

Do this before announcing anything, or the first visitor hits a login wall.

---

## 5. Post-deploy verification

```
curl https://gexxzdlppbplfpfqhszf.supabase.co/functions/v1/gateway/v1/models \
  -H "Authorization: Bearer sk-plat-REPLACE"
```

```
curl -N https://gexxzdlppbplfpfqhszf.supabase.co/functions/v1/gateway/v1/chat/completions \
  -H "Authorization: Bearer sk-plat-REPLACE" \
  -H "content-type: application/json" \
  --max-time 180 \
  --data '{"model":"CREATOR/SLUG","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Then in the SQL editor:

```
select count(*) from api_keys;   -- 0 until you mint the first one
select * from v_balance_drift;   -- MUST be 0 rows
select status, cost_micro_usd, creator_micro_usd, platform_micro_usd, usage_estimated
  from usage_transactions order by created_at desc limit 1;
```

`usage_estimated = t` means the gateway billed from a character estimate rather than
the worker's reported counts. That is a finding, not a footnote.

---

## ⚠️ Never run the seed against production

`supabase/seed.sql` inserts an **active** `api_keys` row whose plaintext is committed
to this public repo. Both the integration and `db push` ignore seeds, so the normal
paths are safe. The way to get it wrong is:

- `supabase db reset --linked` — which also **drops** the remote database
- adding `seed.sql` to a deploy script

After the first deploy, confirm `select count(*) from api_keys` returns 0.

---

## Known gaps at first deploy

| Gap | Consequence |
|---|---|
| **No Creator Studio** | Models can only be added by SQL, so the marketplace ships with no supply side. Biggest functional gap. |
| **No Stripe** | Wallets can only be funded by SQL `credit_wallet` calls. |
| **GitHub OAuth unconfigured** | The sign-in button fails with `provider is not enabled`. Email/password works. |
| **Warm TTFT ~926 ms** vs the 400 ms SLO | Measured miss, unresolved. |
| **MFU is a guessed 0.75** (measured ~0.79) | Decides A10 vs L40S and $0.85/hr. |
