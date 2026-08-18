import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoSecretsInArgv,
  ConfigError,
  isLocalSupabaseUrl,
  PRODUCTION_FLAG,
  resolveConfig,
  SERVICE_ROLE_ENV,
} from "../config.ts";

const FAKE_KEY = "service-role-value-not-a-real-secret";

test("missing SUPABASE_SERVICE_ROLE_KEY fails with a clear, actionable message", () => {
  assert.throws(
    () =>
      resolveConfig({
        env: { SUPABASE_URL: "http://127.0.0.1:54321" },
        allowProduction: false,
      }),
    (e: Error) =>
      e instanceof ConfigError &&
      e.message.includes(SERVICE_ROLE_ENV) &&
      /never accepted as a CLI argument/.test(e.message) &&
      /supabase status/.test(e.message),
  );
});

test("an empty or whitespace-only service role key counts as absent", () => {
  for (const value of ["", "   "]) {
    assert.throws(
      () =>
        resolveConfig({
          env: { SUPABASE_URL: "http://127.0.0.1:54321", [SERVICE_ROLE_ENV]: value },
          allowProduction: false,
        }),
      ConfigError,
    );
  }
});

test("missing SUPABASE_URL fails", () => {
  assert.throws(
    () => resolveConfig({ env: { [SERVICE_ROLE_ENV]: FAKE_KEY }, allowProduction: false }),
    (e: Error) => e instanceof ConfigError && /SUPABASE_URL is not set/.test(e.message),
  );
});

test("local URLs are recognised", () => {
  for (const url of [
    "http://127.0.0.1:54321",
    "http://127.0.0.1:54321/",
    "http://localhost:54321",
    "http://LOCALHOST:54321",
    "http://[::1]:54321",
    "http://0.0.0.0:54321",
    "http://127.9.9.9:54321",
    "http://api.localhost:54321",
    "http://host.docker.internal:54321",
  ]) {
    assert.equal(isLocalSupabaseUrl(url), true, url);
  }
});

test("everything else is treated as production", () => {
  for (const url of [
    "https://abcdefgh.supabase.co",
    "https://127.0.0.1.evil.example.com",
    "https://localhost.evil.example.com",
    "https://10.0.0.5",
    "https://192.168.1.10",
    "not a url",
    "",
  ]) {
    assert.equal(isLocalSupabaseUrl(url), false, url);
  }
});

test("a non-local URL is refused unless the production flag is passed", () => {
  const env = {
    SUPABASE_URL: "https://abcdefgh.supabase.co",
    [SERVICE_ROLE_ENV]: FAKE_KEY,
  };
  assert.throws(
    () => resolveConfig({ env, allowProduction: false }),
    (e: Error) =>
      e instanceof ConfigError &&
      /Refusing to run against a non-local Supabase/.test(e.message) &&
      e.message.includes(PRODUCTION_FLAG),
  );

  const cfg = resolveConfig({ env, allowProduction: true });
  assert.equal(cfg.isLocal, false);
  assert.equal(cfg.url, "https://abcdefgh.supabase.co");
});

test("a local URL needs no flag, and the trailing slash is normalised away", () => {
  const cfg = resolveConfig({
    env: { SUPABASE_URL: "http://127.0.0.1:54321/", [SERVICE_ROLE_ENV]: FAKE_KEY },
    allowProduction: false,
  });
  assert.equal(cfg.isLocal, true);
  assert.equal(cfg.url, "http://127.0.0.1:54321");
  assert.equal(cfg.serviceRoleKey, FAKE_KEY);
});

test("a JWT anywhere in argv is refused, and is never echoed back", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sIgNaTuRe";
  for (const argv of [
    ["create", "--user", "devcaller", "--service-role", jwt],
    [`--service-role=${jwt}`],
    [jwt],
  ]) {
    assert.throws(
      () => assertNoSecretsInArgv(argv),
      (e: Error) =>
        e instanceof ConfigError &&
        /must come from the environment only/.test(e.message) &&
        !e.message.includes(jwt),
    );
  }
});

test("a plaintext sk-plat- key in argv is refused and never echoed back", () => {
  const key = `sk-plat-${"a".repeat(43)}`;
  assert.throws(
    () => assertNoSecretsInArgv(["revoke", key]),
    (e: Error) =>
      e instanceof ConfigError &&
      /never accepted as input/.test(e.message) &&
      !e.message.includes(key),
  );
});

test("ordinary arguments pass through untouched", () => {
  assertNoSecretsInArgv([
    "create",
    "--user",
    "devcaller",
    "--name",
    "my laptop",
    "list",
    "--user",
    "00000000-0000-0000-0000-0000000000a2",
    "sk-plat-a1b2c3d4",
    PRODUCTION_FLAG,
  ]);
});
