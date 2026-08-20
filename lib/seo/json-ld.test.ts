/**
 * Unit tests for the JSON-LD builders.
 * Run: npm run test:app
 *
 * Two things here are load-bearing and would otherwise fail silently.
 *
 * THE PRICE STRING. `offers.price` is the one place a micro-USD integer leaves
 * the system as a decimal amount, and the obvious implementation —
 * `(micro / 1_000_000).toFixed(2)` — is wrong in two independent ways that both
 * look right in a spot check. The assertions below pin the exact string for a
 * value that a two-decimal render loses half a cent on, and for one whose
 * quotient is not representable as a double at all.
 *
 * THE SCRIPT ESCAPE. A description is creator-supplied text that ends up inside
 * a `<script>` element, whose content the HTML parser reads as raw text and
 * terminates at the first `</script`. If `<` survives serialization, a creator
 * writes the closing tag themselves and the rest is arbitrary markup in the
 * document. That is an XSS boundary, so it is tested as one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ModelInput } from "./json-ld.ts";
import {
  buildModelApplication,
  buildModelBreadcrumbs,
  buildOrganization,
  buildWebSite,
  jsonLdScriptContent,
} from "./json-ld.ts";

// Every URL below is a fixed, checkable string rather than whatever
// `site-url.ts` derives from the ambient environment. Assigning after the
// imports is safe — and unavoidable, since ESM evaluates them first — because
// `siteOrigin()` reads the environment on every call, not once at import.
process.env.VERCEL_PROJECT_PRODUCTION_URL = "nexus.example";
delete process.env.VERCEL_URL;

const ORIGIN = "https://nexus.example";

const MODEL: ModelInput = {
  creatorHandle: "jonathancoletti",
  creatorDisplayName: "Jonathan Coletti",
  slug: "qwen3.8-27b-uncensored-gguf",
  modelId: "jonathancoletti/qwen3.8-27b-uncensored-gguf",
  displayName: "Qwen3.8 27B Uncensored",
  description: "A 27B parameter model, 4-bit quantized.",
  pricePromptMicroPerMtoken: 300_000,
  priceCompletionMicroPerMtoken: 1_500_000,
};

/** `offers` is an array, and `noUncheckedIndexedAccess` is on. */
function offerPrice(node: ReturnType<typeof buildModelApplication>, index: number): string {
  const offer = node.offers[index];
  if (!offer) throw new Error(`no offer at index ${index}`);
  return offer.price;
}

/** The price a model would carry if its completion rate were `micro`. */
function completionPrice(micro: number): string {
  return offerPrice(buildModelApplication({ ...MODEL, priceCompletionMicroPerMtoken: micro }), 1);
}

/**
 * No serialized value may start with `/`. A relative URL anywhere in structured
 * data is a silent defect — consumers resolve it against their own base or drop
 * the node — and this catches it in every position at once, including ones a
 * future field adds.
 */
function assertNoRelativeUrls(content: string): void {
  assert.ok(!content.includes(':"/'), `a value in ${content} is a relative URL`);
}

test("micro-USD becomes an exact decimal string, by integer maths only", () => {
  // The everyday cases: $0.30 and $1.50 per 1M tokens.
  assert.equal(completionPrice(300_000), "0.30");
  assert.equal(completionPrice(1_500_000), "1.50");

  // Sub-cent rates survive. The float shortcut does not: `(15_000 / 1e6)
  // .toFixed(2)` is "0.01", which is a third of the real price.
  assert.equal(completionPrice(15_000), "0.015");
  assert.equal((15_000 / 1e6).toFixed(2), "0.01");

  // Every one of the six digits is significant when the rate uses them.
  assert.equal(completionPrice(1_234_567), "1.234567");
  assert.equal(completionPrice(1), "0.000001");
  assert.equal(completionPrice(0), "0.00");
});

test("the precision case: an integer whose quotient is not representable", () => {
  // 8_646_185_760_324_872 is below Number.MAX_SAFE_INTEGER, so the input itself
  // is exact — it is the DIVISION that loses the last digit. An absurd price,
  // and that is the point: the string route has no magnitude at which it starts
  // being wrong, so there is no threshold anyone has to remember.
  const micro = 8_646_185_760_324_872;
  assert.ok(Number.isSafeInteger(micro));

  assert.equal(completionPrice(micro), "8646185760.324872");

  // Pinned so this test cannot quietly stop proving anything: if a future V8
  // made the float route exact, the assertion above would no longer be
  // distinguishing the two implementations, and this line would fail first.
  assert.equal((micro / 1_000_000).toFixed(6), "8646185760.324871");
});

test("an offer prices 1,000,000 tokens, in USD, in both directions", () => {
  const node = buildModelApplication(MODEL);

  assert.equal(node.offers.length, 2);
  const [input, output] = node.offers;
  assert.ok(input);
  assert.ok(output);

  assert.equal(input.name, "Input tokens");
  assert.equal(input.price, "0.30");
  assert.equal(input.priceCurrency, "USD");
  assert.equal(input.priceSpecification.priceCurrency, "USD");
  assert.equal(input.priceSpecification.referenceQuantity.value, 1_000_000);
  assert.equal(input.priceSpecification.referenceQuantity.unitText, "tokens");

  assert.equal(output.name, "Output tokens");
  assert.equal(output.price, "1.50");
});

test("optional fields are absent, never present-and-undefined", () => {
  const node = buildModelApplication({
    ...MODEL,
    description: null,
    creatorDisplayName: null,
  });

  assert.equal("description" in node, false);
  assert.equal(JSON.stringify(node).includes("description"), false);

  // A creator with no display name is credited by handle rather than by a blank.
  assert.equal(node.author.name, "jonathancoletti");

  // Whitespace-only is the same absence with a different spelling.
  const blank = buildModelApplication({ ...MODEL, description: "   ", creatorDisplayName: "  " });
  assert.equal("description" in blank, false);
  assert.equal(blank.author.name, "jonathancoletti");
});

test("a description is present when there is one, collapsed to single spaces", () => {
  const node = buildModelApplication({
    ...MODEL,
    description: "  A 27B parameter model,\n  4-bit quantized.  ",
  });
  assert.equal(node.description, "A 27B parameter model, 4-bit quantized.");
});

test("every URL position on the model node is absolute", () => {
  const node = buildModelApplication(MODEL);
  const url = `${ORIGIN}/models/jonathancoletti/qwen3.8-27b-uncensored-gguf`;

  assert.equal(node.url, url);
  assert.equal(node["@id"], url);
  // The author links to the catalog filtered by creator — a real page, and the
  // `creator` parameter the catalog actually parses.
  assert.equal(node.author.url, `${ORIGIN}/models?creator=jonathancoletti`);
  assert.equal(node.identifier, "jonathancoletti/qwen3.8-27b-uncensored-gguf");

  assertNoRelativeUrls(jsonLdScriptContent(node));
});

test("the organization node is absolute in name, url and logo", () => {
  const node = buildOrganization({ name: "Nexus", logoPath: "/logo.png" });

  assert.equal(node.name, "Nexus");
  assert.equal(node.url, `${ORIGIN}/`);
  assert.equal(node.logo, `${ORIGIN}/logo.png`);
  assert.equal(node["@id"], `${ORIGIN}/#organization`);

  assertNoRelativeUrls(jsonLdScriptContent(node));
});

test("the site's SearchAction names the catalog's real query parameter", () => {
  const node = buildWebSite({ name: "Nexus" });

  // `q`, from `parseCatalogQuery`. A wrong name here does not error anywhere —
  // it just sends every searchbox visitor to an unfiltered catalog.
  assert.equal(node.potentialAction.target.urlTemplate, `${ORIGIN}/models?q={search_term_string}`);
  assert.equal(node.potentialAction["query-input"], "required name=search_term_string");

  // The braces must survive un-encoded: the consumer substitutes into them.
  assert.ok(!node.potentialAction.target.urlTemplate.includes("%7B"));

  assert.equal(node.url, `${ORIGIN}/`);
  assert.equal(node.publisher["@id"], `${ORIGIN}/#organization`);
  assertNoRelativeUrls(jsonLdScriptContent(node));
});

test("the breadcrumb trail is catalog -> creator -> model, positions in order", () => {
  const node = buildModelBreadcrumbs({
    creatorHandle: "jonathancoletti",
    creatorDisplayName: "Jonathan Coletti",
    slug: "qwen3.8-27b-uncensored-gguf",
    displayName: "Qwen3.8 27B Uncensored",
  });

  assert.deepEqual(
    node.itemListElement.map((item) => item.position),
    [1, 2, 3],
  );
  assert.deepEqual(
    node.itemListElement.map((item) => item.name),
    ["Models", "Jonathan Coletti", "Qwen3.8 27B Uncensored"],
  );
  assert.deepEqual(
    node.itemListElement.map((item) => item.item),
    [
      // The catalog crumb is `/models`. It was `/` while the catalog lived
      // there and `/models` was a redirect; the landing rebuild swapped them.
      `${ORIGIN}/models`,
      `${ORIGIN}/models?creator=jonathancoletti`,
      `${ORIGIN}/models/jonathancoletti/qwen3.8-27b-uncensored-gguf`,
    ],
  );

  assertNoRelativeUrls(jsonLdScriptContent(node));
});

test("a breadcrumb falls back to the handle when there is no display name", () => {
  const node = buildModelBreadcrumbs({
    creatorHandle: "jonathancoletti",
    creatorDisplayName: null,
    slug: "qwen3.8-27b-uncensored-gguf",
    displayName: "Qwen3.8 27B Uncensored",
  });

  assert.equal(node.itemListElement[1]?.name, "jonathancoletti");
});

test("a creator cannot close the script tag from inside a description", () => {
  const attack = '</script><img src=x onerror="alert(1)">';
  const content = jsonLdScriptContent(buildModelApplication({ ...MODEL, description: attack }));

  // The only thing that terminates a script element is `</script`, and it takes
  // a literal `<` to write one. There is none left in the output.
  assert.ok(!content.includes("<"));
  assert.ok(!content.toLowerCase().includes("</script"));
  assert.ok(content.includes("\\u003c/script"));

  // ...and the escape is lossless: a parser hands the original text back, so
  // this is an encoding, not a mangling of what the creator wrote.
  const parsed: unknown = JSON.parse(content);
  assert.equal(
    parsed && typeof parsed === "object" && "description" in parsed
      ? parsed.description
      : undefined,
    attack,
  );
});

test("the escape covers every string in the node, not just the description", () => {
  const content = jsonLdScriptContent(
    buildModelApplication({
      ...MODEL,
      displayName: "<b>Qwen</b>",
      creatorDisplayName: "<script>",
      slug: "a<b",
    }),
  );

  assert.ok(!content.includes("<"));
});

test("the serialized node is valid JSON and JSON only", () => {
  // `jsonLdScriptContent` must never wrap its output in a tag or a CDATA
  // section: the caller owns the element, and anything but bare JSON inside it
  // makes the block invalid for every consumer.
  const content = jsonLdScriptContent(buildOrganization({ name: "Nexus", logoPath: "/logo.png" }));

  assert.ok(content.startsWith("{"));
  assert.ok(content.endsWith("}"));

  const parsed: unknown = JSON.parse(content);
  assert.ok(parsed && typeof parsed === "object");
  assert.equal("@context" in parsed ? parsed["@context"] : null, "https://schema.org");
});
