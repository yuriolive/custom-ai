# `tools/keygen` — platform API key CLI

Mints, lists, and revokes `sk-plat-…` keys. Before this existed, the only API key
on the platform was the one hardcoded in `supabase/seed.sql`.

Zero dependencies. Runs under Node 24's native type stripping — no build step.

## Usage

```sh
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)"

node tools/keygen/cli.ts create --user devcaller --name "my laptop"
node tools/keygen/cli.ts list   --user devcaller
node tools/keygen/cli.ts revoke sk-plat-3yUEKKEa        # prompts
node tools/keygen/cli.ts revoke <key-uuid> --yes        # doesn't
```

`--user` takes a profile handle or a uuid. `revoke` takes a key uuid or the
16-character display prefix shown by `list` — never a plaintext key.

## The key format

Owned by `supabase/functions/gateway/auth.ts`, which is the module that has to
_accept_ these keys. `key.ts` re-exports it rather than reimplementing it, so the
two cannot drift. `test/key.test.ts` asserts function identity, digest agreement
with `node:crypto`, and conformance to the CHECK constraints read live out of
`supabase/migrations/20260817000500_api_keys.sql`.

```
plaintext   sk-plat- + 43 url-safe base64 chars   (32 random bytes)   51 chars
key_hash    sha256(plaintext), lower-case hex                         64 chars
key_prefix  plaintext.slice(0, 16) = 'sk-plat-' + 8                   16 chars
```

## Security properties

- **The plaintext is emitted exactly once**, on **stdout**, from a single
  `io.out()` call in `commands.ts`. It is never written to a file, a log line, an
  error message, or the database. Everything else — banner, metadata, prompts,
  errors — goes to **stderr**, so `create … | pass insert` captures the credential
  and nothing else, and `create … > /dev/null` shows you everything but it.
- **Only the SHA-256 hash is persisted.** `create` re-hashes the value it is about
  to print and refuses to insert if the digest, the key format, or either schema
  CHECK disagrees — every run, not just under test.
- **`SUPABASE_SERVICE_ROLE_KEY` is read from the environment only.** It is never a
  CLI argument. `assertNoSecretsInArgv` aborts if a JWT or a full plaintext key
  appears in `argv` at all, because by then it is already in the shell history.
  PostgREST error bodies are scanned and the key redacted before printing.
- **No read path selects `key_hash`.** `SAFE_KEY_COLUMNS` is the only projection,
  and a test greps `db.ts` to prove `key_hash` never appears in a `select=` list.
- **Non-local `SUPABASE_URL` is refused** unless `--i-know-this-is-production` is
  passed. Loopback, `*.localhost`, `127.0.0.0/8`, and the Docker/Kong hostnames
  count as local; a `*.supabase.co` project ref does not.
- **`revoke` requires confirmation** and refuses an ambiguous prefix rather than
  guessing which credential to kill.

## Tests

```sh
npm test      --workspace @custom-ai/keygen   # 39 tests, no database needed
npm run typecheck --workspace @custom-ai/keygen
```

The database is behind the `KeyStore` interface, so unit tests use an in-memory
double. The opt-in live smoke test uses the _same_ code path against a real
instance and revokes what it mints in an `after` hook, pass or fail:

```sh
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=... \
node --test tools/keygen/test/live-smoke.live.ts
```

It is excluded from `npm test` by filename (`*.live.ts`, not `*.test.ts`).
