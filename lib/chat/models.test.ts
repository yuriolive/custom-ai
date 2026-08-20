/**
 * Unit tests for chat model selection.
 * Run: npm run test:app
 *
 * The load-bearing assertion here is that a `?model=` naming something the
 * catalog does not serve NEVER produces an error state — it falls back and says
 * so. That link is the marketplace's conversion path (FR-CHAT-004), and the
 * most likely reason it goes stale is a creator unpublishing a model, which is
 * a normal event rather than a broken URL.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CatalogModel } from "@/components/marketplace/types";

import { defaultModel, normalizeModelId, pickInitialModel, typicalExchangeMicroUsd } from "./models.ts";

function model(overrides: Partial<CatalogModel> & { modelId: string }): CatalogModel {
  const [creatorHandle = "creator", slug = "slug"] = overrides.modelId.split("/");
  return {
    id: overrides.modelId,
    creatorHandle,
    creatorDisplayName: null,
    slug,
    displayName: "A model",
    description: null,
    measuredTokensPerSecond: 40,
    contextLength: 8192,
    contextVerified: true,
    quantTag: null,
    qualityTier: "balanced",
    pricePromptMicroPerMtoken: 200_000,
    priceCompletionMicroPerMtoken: 600_000,
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    p50TtftMs: null,
    p95TtftMs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    readyAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeModelId", () => {
  it("lowercases both halves, because resolve.ts does", () => {
    assert.equal(
      normalizeModelId("JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"),
      "jonathancoletti/qwen3.8-27b-uncensored-gguf",
    );
  });

  it("trims surrounding whitespace from a pasted id", () => {
    assert.equal(normalizeModelId("  creator/slug \n"), "creator/slug");
  });

  it("rejects anything that is not exactly two non-empty halves", () => {
    for (const bad of ["", "   ", "noslash", "a/b/c", "/slug", "creator/", "/"]) {
      assert.equal(normalizeModelId(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it("rejects a non-string and an absurd length", () => {
    assert.equal(normalizeModelId(null), null);
    assert.equal(normalizeModelId(undefined), null);
    assert.equal(normalizeModelId(`${"a".repeat(120)}/${"b".repeat(120)}`), null);
  });
});

describe("defaultModel", () => {
  it("is null on an empty catalog", () => {
    assert.equal(defaultModel([]), null);
  });

  it("picks the most-requested model, as the closest thing to a warmth signal", () => {
    const chosen = defaultModel([
      model({ modelId: "a/one", totalRequests: 10 }),
      model({ modelId: "b/two", totalRequests: 900 }),
      model({ modelId: "c/three", totalRequests: 3 }),
    ]);
    assert.equal(chosen?.modelId, "b/two");
  });

  it("breaks ties deterministically so the default does not flip between renders", () => {
    const models = [model({ modelId: "b/two" }), model({ modelId: "a/one" })];
    assert.equal(defaultModel(models)?.modelId, "a/one");
    assert.equal(defaultModel(models.toReversed())?.modelId, "a/one");
  });
});

describe("pickInitialModel", () => {
  const catalog = [
    model({ modelId: "a/one", totalRequests: 5 }),
    model({ modelId: "b/two", totalRequests: 50 }),
  ];

  it("honours a requested model, case-insensitively", () => {
    const choice = pickInitialModel(catalog, "A/One");
    assert.equal(choice.model?.modelId, "a/one");
    assert.equal(choice.unavailableModelId, null);
  });

  it("falls back and reports, rather than failing, on an unpublished model", () => {
    const choice = pickInitialModel(catalog, "gone/away");
    assert.equal(choice.model?.modelId, "b/two");
    assert.equal(choice.unavailableModelId, "gone/away");
  });

  it("treats a malformed id as no request at all", () => {
    const choice = pickInitialModel(catalog, "not-a-model-id");
    assert.equal(choice.model?.modelId, "b/two");
    // Nothing to tell the user about: they did not ask for a specific model in
    // any way the product can act on.
    assert.equal(choice.unavailableModelId, null);
  });

  it("returns no model at all for an empty catalog", () => {
    assert.deepEqual(pickInitialModel([], "a/one"), {
      model: null,
      unavailableModelId: "a/one",
    });
  });
});

describe("typicalExchangeMicroUsd", () => {
  it("rounds each side up, matching the billing direction", () => {
    // 500 * 200000 / 1e6 = 100 ; 500 * 600000 / 1e6 = 300
    assert.equal(typicalExchangeMicroUsd(model({ modelId: "a/one" })), 400);
  });

  it("never quotes zero for a model that is not free", () => {
    const nearlyFree = model({
      modelId: "a/one",
      pricePromptMicroPerMtoken: 1,
      priceCompletionMicroPerMtoken: 1,
    });
    assert.equal(typicalExchangeMicroUsd(nearlyFree), 2);
  });

  it("honours the one-microdollar floor on a free model", () => {
    const free = model({
      modelId: "a/one",
      pricePromptMicroPerMtoken: 0,
      priceCompletionMicroPerMtoken: 0,
    });
    assert.equal(typicalExchangeMicroUsd(free), 1);
  });
});
