/**
 * Unit tests for the Hugging Face userinfo parse.
 * Run: npm run test:app
 *
 * The parse is where a badge is won or lost, and both directions matter:
 *
 * - **Losing one wrongly** is invisible. A response whose org list sits under
 *   the key this parser does not read produces an org-less creator, no error,
 *   and a badge that simply never appears — the kind of defect nobody files.
 * - **Winning one wrongly** is worse. Reading an org's *display name* as its
 *   namespace, or accepting a payload with no `sub`, hands out a claim of
 *   ownership the sign-in did not establish.
 *
 * So the fixtures below are shaped like the two payloads that are actually in
 * circulation for one endpoint: `orgs` (how `@huggingface/hub` types it) and
 * `organizations` (how the Hub's OAuth docs name it, in `organizations.sub`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseHfUserInfo } from "./userinfo.ts";

const BASE = {
  sub: "62a1b2c3d4e5f60718293a4b",
  name: "Jonathan Coletti",
  preferred_username: "JonathanColetti",
  picture: "https://example.invalid/avatar.png",
  profile: "https://huggingface.co/JonathanColetti",
};

test("a minimal profile yields the username, lowercased", () => {
  const facts = parseHfUserInfo(BASE);
  assert.equal(facts?.username, "jonathancoletti");
  assert.equal(facts?.sub, BASE.sub);
});

test("no memberships list at all is not the same as an empty one", () => {
  // This is the missing-`read-memberships`-scope case, and it is why the flag
  // exists: without it, "we were never allowed to look" is indistinguishable
  // from "this account is in no orgs", and the dashboard misconfiguration that
  // causes it is undiagnosable.
  const facts = parseHfUserInfo(BASE);
  assert.deepEqual(facts?.orgs, []);
  assert.equal(facts?.membershipsReadable, false);
});

test("an explicitly empty memberships list is readable and empty", () => {
  const facts = parseHfUserInfo({ ...BASE, orgs: [] });
  assert.deepEqual(facts?.orgs, []);
  assert.equal(facts?.membershipsReadable, true);
});

test("orgs are read under `orgs`", () => {
  const facts = parseHfUserInfo({
    ...BASE,
    orgs: [
      { sub: "org-1", name: "Qwen", preferred_username: "Qwen", isEnterprise: false },
      { sub: "org-2", name: "Meta Llama", preferred_username: "meta-llama" },
    ],
  });
  assert.deepEqual(facts?.orgs, ["meta-llama", "qwen"]);
  assert.equal(facts?.membershipsReadable, true);
});

test("orgs are also read under `organizations`", () => {
  // The Hub's OAuth page documents this key ("the `organizations.sub` field of
  // the userinfo response"). Reading only the other one would be a silent miss.
  const facts = parseHfUserInfo({
    ...BASE,
    organizations: [{ sub: "org-1", name: "Qwen", preferred_username: "Qwen" }],
  });
  assert.deepEqual(facts?.orgs, ["qwen"]);
  assert.equal(facts?.membershipsReadable, true);
});

test("an org's display name is never mistaken for its namespace", () => {
  // `name` is "Meta Llama" where the namespace is `meta-llama`. Falling back to
  // `name` would either match nothing or, worse, match the wrong thing.
  const facts = parseHfUserInfo({
    ...BASE,
    orgs: [{ sub: "org-1", name: "Meta Llama" }],
  });
  assert.deepEqual(facts?.orgs, []);
  // The list was present, so this stays true — the account is in an org whose
  // namespace we could not read, which is still "we were allowed to look".
  assert.equal(facts?.membershipsReadable, true);
});

test("a payload naming no usable account is null", () => {
  assert.equal(parseHfUserInfo(null), null);
  assert.equal(parseHfUserInfo("JonathanColetti"), null);
  assert.equal(parseHfUserInfo([BASE]), null);
  assert.equal(parseHfUserInfo({ ...BASE, sub: "" }), null);
  assert.equal(parseHfUserInfo({ ...BASE, preferred_username: undefined }), null);
  assert.equal(parseHfUserInfo({ ...BASE, preferred_username: "has space" }), null);
});

test("a non-array memberships value is treated as absent, not as empty", () => {
  const facts = parseHfUserInfo({ ...BASE, orgs: "Qwen" });
  assert.deepEqual(facts?.orgs, []);
  assert.equal(facts?.membershipsReadable, false);
});
