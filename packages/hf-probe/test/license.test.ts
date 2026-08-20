/**
 * Licence -> `commercial_hosting`. The question is not "what licence is this"
 * but "may a third party serve these weights for money", so the tests are
 * written as that question.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  commercialHostingFor,
  licenseFromCardData,
  normalizeLicenseId,
  strictest,
} from "../src/license.ts";

test("permissive licences are `allowed`", () => {
  for (const id of ["apache-2.0", "mit", "bsd-3-clause", "cc0-1.0", "MIT", " apache-2.0 "]) {
    assert.equal(commercialHostingFor(id), "allowed", id);
  }
});

test("licences with obligations a human must read are `conditional`", () => {
  for (const id of ["llama3.1", "llama2", "gemma", "cc-by-4.0", "openrail", "apple-ascl"]) {
    assert.equal(commercialHostingFor(id), "conditional", id);
  }
});

test("non-commercial and no-derivatives licences are `prohibited`", () => {
  for (const id of [
    "cc-by-nc-4.0",
    "cc-by-nc-sa-4.0",
    "cc-by-nc-nd-4.0",
    "cc-by-nd-4.0",
    "deepfloyd-if-license",
    "intel-research",
  ]) {
    assert.equal(commercialHostingFor(id), "prohibited", id);
  }
});

test("`other`, absent and unrecognised are all `unknown` — and never `allowed`", () => {
  assert.equal(commercialHostingFor("other"), "unknown");
  assert.equal(commercialHostingFor(null), "unknown");
  assert.equal(commercialHostingFor(undefined), "unknown");
  assert.equal(commercialHostingFor(""), "unknown");
  assert.equal(commercialHostingFor("some-lab-custom-terms"), "unknown");
});

test("normalizeLicenseId collapses the Hub's non-answers to null", () => {
  assert.equal(normalizeLicenseId("Apache-2.0"), "apache-2.0");
  assert.equal(normalizeLicenseId("other"), null);
  assert.equal(normalizeLicenseId("unknown"), null);
  assert.equal(normalizeLicenseId(42), null);
});

test("`license: other` plus a research-only license_name is still prohibited", () => {
  const parsed = licenseFromCardData(
    {
      license: "other",
      license_name: "qwen-research",
      license_link: "LICENSE",
    },
    { repoSlug: "Qwen/Qwen3-8B-Research", revision: "main" },
  );

  assert.ok(parsed);
  assert.equal(parsed.id, null);
  assert.equal(parsed.name, "qwen-research");
  assert.equal(parsed.commercialHosting, "prohibited");
  // A repo-relative link is absolutized: a link that resolves to nothing is
  // worse than none, because it is the one a creator clicks to read the terms.
  assert.equal(parsed.url, "https://huggingface.co/Qwen/Qwen3-8B-Research/blob/main/LICENSE");
});

test("an unrecognised license_name does not downgrade a recognised id", () => {
  const parsed = licenseFromCardData({ license: "apache-2.0", license_name: "see repo" });
  assert.equal(parsed?.commercialHosting, "allowed");
});

test("a licence list takes its first entry", () => {
  assert.equal(licenseFromCardData({ license: ["mit", "apache-2.0"] })?.id, "mit");
});

test("a card that says nothing about licensing yields null, not a guess", () => {
  assert.equal(licenseFromCardData({ base_model: "Qwen/Qwen3-8B" }), null);
  assert.equal(licenseFromCardData(null), null);
});

test("strictest defers on `unknown` and wins on a real classification", () => {
  assert.equal(strictest("allowed", "unknown"), "allowed");
  assert.equal(strictest("unknown", "prohibited"), "prohibited");
  assert.equal(strictest("conditional", "prohibited"), "prohibited");
  assert.equal(strictest("unknown", "unknown"), "unknown");
});
