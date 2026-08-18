# Deploy runbook

Two hosts. **Supabase alone is not sufficient** — it runs Postgres, Auth, Edge
Functions and Storage, but it does not host a Next.js SSR app, and this app cannot
be statically exported (`/` is `force-dynamic`, middleware runs per request, auth
uses Server Actions and cookies).

| Piece | Host | Deployed by |
|---|---|---|
| Postgres, Auth, `gateway` Edge Function | Supabase | GitHub Actions (`deploy-supabase`) |
| Next.js web app | Vercel | Vercel's own Git integration |
| llama.cpp inference worker | Modal | `modal deploy` from a workstation |

Vercel deploys itself from Git on purpose: it keeps Vercel's token out of GitHub, so
this repo holds one set of deploy credentials instead of two.

---

## 0. Prerequisites

- Supabase project `gexxzdlppbplfpfqhszf` (exists, never deployed to)
- A Vercel account
- Modal CLI authenticated — already configured
- **`main` must contain the code.** The deploy job is gated on `push` to `main`;
  work currently lives on `mvp-0-foundation`.

---

## 1. Modal — deploy the worker and leave it running

Every run so far ended in teardown. Production needs it *deployed*. With
`min_containers=0` a live app still costs **$0 while idle**, so leaving it up is not
a standing charge.

    cd tools/modal
    uv sync --group deploy
    modal deploy app.py

Note the URL it prints for the tier you intend to serve, e.g.
`https://<workspace>--nexus-llamacpp-llamaserverl4-serve.modal.run`

Mint a **proxy** token — not the API token. An `ak-`/`as-` API token can deploy and
**delete** apps; a `wk-`/`ws-` proxy token can only invoke. The gateway gets the
proxy pair:

    modal workspace proxy-tokens create

Keep both values out of shell history and out of the repo.

---

## 2. Supabase — link, push schema, deploy the function

### 2a. Create the GitHub secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | from supabase.com/dashboard/account/tokens |
| `SUPABASE_PROJECT_REF` | `gexxzdlppbplfpfqhszf` |
| `SUPABASE_DB_PASSWORD` | the project's database password |

Optionally create an Environment named `production` with required reviewers, which
adds a human gate in front of every deploy.

### 2b. Set the function secrets — ONCE, out of band

Deliberately **not** managed by CI, so Modal credentials live in one place rather
than two:

    npx supabase secrets set --project-ref gexxzdlppbplfpfqhszf \
      UPSTREAM_PROVIDER=modal \
      UPSTREAM_BASE_URL=https://WORKSPACE--nexus-llamacpp-llamaserverl4-serve.modal.run \
      MODAL_KEY=wk-REPLACE \
      MODAL_SECRET=ws-REPLACE

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into
deployed functions — do not set them yourself.

### 2c. Fix the auth URLs before the first sign-up

`supabase/config.toml` still carries local values (`site_url` is
`http://127.0.0.1:3000`). Set the production origin in **Dashboard → Authentication
→ URL Configuration** — both Site URL and Redirect URLs. Left as-is, every
confirmation email and OAuth redirect points at localhost and nobody can complete a
sign-up.

### 2d. Merge to `main`

    git checkout main && git merge mvp-0-foundation && git push origin main

The `deploy-supabase` job then runs after all four verification jobs pass:
link → migration list → db push → functions deploy gateway.

---

## 3. Vercel — the web app

**Already done** (project linked, `.vercel/` is gitignored):

    project   custom-ai   prj_eZdaV2VMr6awRNeGg1V2HET42AXs
    scope     yuri-olives-projects-852572a4

Production env vars already set — these need no credential, they are derived
from the project ref:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://gexxzdlppbplfpfqhszf.supabase.co` |
| `SUPABASE_URL` | same |
| `GATEWAY_BASE_URL` | `https://gexxzdlppbplfpfqhszf.supabase.co/functions/v1/gateway/v1` |

### Remaining four — each blocked on a credential only you can read

Get the anon and service-role keys from
**Dashboard → Project Settings → API**. Each command below prompts for the value,
so it never lands in shell history:

    vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
    vercel env add SUPABASE_ANON_KEY production        # same value as above
    vercel env add SUPABASE_SERVICE_ROLE_KEY production # SECRET

`PLATFORM_API_KEY` cannot be set yet **in principle**, not just in practice: it must
be a key minted against the *production* database, which does not exist until step
2d has run. Mint it after the Supabase deploy:

    node tools/keygen/cli.ts create --user <handle> --name "playground"       --i-know-this-is-production
    vercel env add PLATFORM_API_KEY production

### Then deploy

    vercel --prod

**Do not deploy before the anon key is set.** The build genuinely fails without it —
`/auth/callback` page-data collection throws on the auth module's absence check, and
Next inlines `NEXT_PUBLIC_*` at build time. CI hit exactly this and it is why the
build step carries placeholder values.

Finally, set the resulting Vercel URL as Supabase's Site URL (step 2c), or every
confirmation email still points at localhost.

---

## 4. Post-deploy verification

Gateway reachable and authenticating:

    curl https://gexxzdlppbplfpfqhszf.supabase.co/functions/v1/gateway/v1/models \
      -H "Authorization: Bearer sk-plat-REPLACE"

A real streamed completion, billed:

    curl -N https://gexxzdlppbplfpfqhszf.supabase.co/functions/v1/gateway/v1/chat/completions \
      -H "Authorization: Bearer sk-plat-REPLACE" \
      -H "content-type: application/json" \
      --max-time 180 \
      --data '{"model":"CREATOR/SLUG","messages":[{"role":"user","content":"hi"}],"stream":true}'

Then in the SQL editor:

    select count(*) from api_keys;   -- MUST be 0 before you mint the first one
    select * from v_balance_drift;   -- MUST be 0 rows
    select status, cost_micro_usd, creator_micro_usd, platform_micro_usd,
           usage_estimated
      from usage_transactions order by created_at desc limit 1;

`usage_estimated = t` means the gateway billed from a character estimate rather than
the worker's reported counts. That is a finding, not a footnote.

---

## Never run the seed against production

`supabase/seed.sql` inserts an **active** `api_keys` row whose plaintext is committed
to this public repo. `db push` applies migrations only and never seeds, so the deploy
path is safe — but:

- **never** run `supabase db reset --linked` (it also DROPS the remote database)
- **never** add `seed.sql` to a deploy script

After the first deploy, confirm `select count(*) from api_keys` returns 0.

---

## Known gaps at first deploy

| Gap | Consequence |
|---|---|
| **No Creator Studio** | Models can only be added by SQL, so the marketplace has no supply side. Biggest functional gap. |
| **No Stripe** | Wallets can only be funded by SQL `credit_wallet` calls. |
| **GitHub OAuth unconfigured** | The button fails with `provider is not enabled`. Email/password works. |
| **Warm TTFT ~926 ms** vs the 400 ms SLO | Measured miss, unresolved. |
| **MFU is a guessed 0.75** (measured ~0.79) | Decides A10 vs L40S and $0.85/hr. |
