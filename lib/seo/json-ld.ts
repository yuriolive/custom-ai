/**
 * JSON-LD builders for the public marketing surfaces.
 *
 * Pure data in, plain serializable object out. No React, no `<script>` tag, no
 * DOM — a builder that returned markup could not be asserted on, and the whole
 * value of structured data is that it is checkable. Rendering is the caller's
 * job; `jsonLdScriptContent` below produces the exact string the tag needs.
 *
 * THE MONEY RULE APPLIES HERE TOO. Prices arrive as integer micro-USD per
 * 1,000,000 tokens (CONTRACTS.md §Money, and the `price*MicroPerMtoken` fields
 * on `CatalogModel`), while schema.org wants a decimal amount in a currency.
 * That conversion happens exactly once, in `microUsdToAmount`, by integer
 * arithmetic and string assembly — never by dividing into a JS number, which
 * would put a float on a monetary path on the way out of the building.
 *
 * The `.ts` extension on the import below is deliberate: these builders are
 * covered by `node --test`, which resolves specifiers itself and neither
 * extension-guesses nor understands the `@/` alias.
 */

import { absoluteUrl } from "./site-url.ts";

/** Every node carries the same context; typed as a literal so a typo cannot pass. */
type SchemaContext = "https://schema.org";

const CONTEXT: SchemaContext = "https://schema.org";

/**
 * The catalog's search parameter, from `parseCatalogQuery` in
 * `components/marketplace/search-params.ts` — `q`, not `query` or `search`. A
 * `SearchAction` naming a parameter the catalog ignores does not fail loudly;
 * it silently sends every sitelinks-searchbox visitor to an unfiltered catalog.
 *
 * Duplicated rather than imported because `components/` is unreachable from
 * `node --test` (those modules import through the `@/` alias, which the test
 * runner does not resolve), and pulling a client module into a metadata path
 * would drag HeroUI along with it.
 */
const CATALOG_SEARCH_PARAM = "q";

/** Likewise the creator filter (`?creator=handle`), used by the breadcrumb trail. */
const CATALOG_CREATOR_PARAM = "creator";

/**
 * The catalog lives at `/`; `/models` is a permanent redirect to it
 * (`app/models/page.tsx`). Structured data therefore points at `/` — naming the
 * redirect would publish a URL that never serves a 200.
 */
const CATALOG_PATH = "/";

export type OrganizationNode = {
  "@context": SchemaContext;
  "@type": "Organization";
  "@id": string;
  name: string;
  url: string;
  logo: string;
};

type EntryPointNode = {
  "@type": "EntryPoint";
  urlTemplate: string;
};

type SearchActionNode = {
  "@type": "SearchAction";
  target: EntryPointNode;
  /** schema.org spells this one with a hyphen; it is not a typo. */
  "query-input": "required name=search_term_string";
};

export type WebSiteNode = {
  "@context": SchemaContext;
  "@type": "WebSite";
  "@id": string;
  name: string;
  url: string;
  publisher: { "@type": "Organization"; "@id": string };
  potentialAction: SearchActionNode;
};

type QuantitativeValueNode = {
  "@type": "QuantitativeValue";
  value: number;
  unitText: string;
};

type UnitPriceSpecificationNode = {
  "@type": "UnitPriceSpecification";
  price: string;
  priceCurrency: "USD";
  referenceQuantity: QuantitativeValueNode;
};

type OfferNode = {
  "@type": "Offer";
  name: string;
  price: string;
  priceCurrency: "USD";
  priceSpecification: UnitPriceSpecificationNode;
};

type PersonNode = {
  "@type": "Person";
  name: string;
  url: string;
};

/**
 * WHY `SoftwareApplication` AND NOT `Product`.
 *
 * What is listed is software reached over an HTTP API, billed per token — it is
 * never shipped, stocked, returned, or held in a condition. `Product` carries
 * all of that baggage: its consumers (Google Merchant chief among them) read
 * `availability`, `itemCondition` and shipping/return semantics into a listing,
 * and every one of those would be either absent or a lie here.
 * `SoftwareApplication` says the true thing, and `offers` is legitimate on it —
 * schema.org lists `CreativeWork`, its supertype, in the domain of `offers`, so
 * the price rides along without pretending the model is merchandise.
 */
export type ModelApplicationNode = {
  "@context": SchemaContext;
  "@type": "SoftwareApplication";
  "@id": string;
  name: string;
  url: string;
  /** The id a caller passes as `model` — `creator-handle/model-slug`. */
  identifier: string;
  applicationCategory: "DeveloperApplication";
  /**
   * The model runs on the platform's GPUs, not the visitor's machine, so no
   * client OS is required. schema.org has no "not applicable" for this and
   * consumers expect the field on a SoftwareApplication, so it is answered
   * rather than omitted.
   */
  operatingSystem: string;
  description?: string;
  author: PersonNode;
  offers: OfferNode[];
};

type ListItemNode = {
  "@type": "ListItem";
  position: number;
  name: string;
  item: string;
};

export type BreadcrumbListNode = {
  "@context": SchemaContext;
  "@type": "BreadcrumbList";
  "@id": string;
  itemListElement: ListItemNode[];
};

/** Anything these builders produce, and the only thing the serializer accepts. */
export type JsonLdNode = OrganizationNode | WebSiteNode | ModelApplicationNode | BreadcrumbListNode;

/**
 * Integer micro-USD to a schema.org decimal amount: 1_500_000 -> "1.50",
 * 15_000 -> "0.015", 1_234_567 -> "1.234567".
 *
 * NO DIVISION HAPPENS ANYWHERE IN HERE. Micro-USD means the decimal point sits
 * six digits from the right, so placing it is a string operation on the
 * integer's own digits — exact for every input, including the ones where
 * `micro / 1_000_000` is not. `8_646_185_760_324_872` is an exactly
 * representable integer whose quotient is not: the float route renders it
 * `…324871`, one micro-USD light. Two-decimal shortcuts are worse still —
 * `(15_000 / 1e6).toFixed(2)` is `"0.01"`, half a cent short.
 *
 * Trailing zeros are trimmed to a minimum of two decimals, which is a pure
 * spelling change: "1.500000" and "1.50" are the same amount, and no consumer
 * of a price string reads significance into the padding.
 *
 * A fractional input is truncated rather than rejected. Nothing upstream should
 * produce one — the columns are integers — and throwing here would take down a
 * marketing page over a rendering detail.
 */
function microUsdToAmount(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(micro))).padStart(7, "0");
  const whole = digits.slice(0, -6);
  const frac = digits.slice(-6).replace(/(\d\d)0+$/, "$1");
  return `${sign}${whole}.${frac}`;
}

export type OrganizationInput = {
  name: string;
  /** Site-relative path to the logo, e.g. `/logo.png`. */
  logoPath: string;
};

export function buildOrganization(input: OrganizationInput): OrganizationNode {
  return {
    "@context": CONTEXT,
    "@type": "Organization",
    // A fragment `@id` on the site root, so every node referencing the publisher
    // references the same one rather than a second copy of it.
    "@id": absoluteUrl("/#organization"),
    name: input.name,
    url: absoluteUrl("/"),
    logo: absoluteUrl(input.logoPath),
  };
}

export type WebSiteInput = {
  name: string;
};

/**
 * The site node, carrying the sitelinks search box.
 *
 * `urlTemplate` keeps `{search_term_string}` literal — it is a template the
 * consumer substitutes into, so percent-encoding the braces would break it. The
 * WHATWG URL serializer leaves `{` and `}` alone in a query, which is why this
 * can still go through `absoluteUrl` like every other URL here.
 */
export function buildWebSite(input: WebSiteInput): WebSiteNode {
  return {
    "@context": CONTEXT,
    "@type": "WebSite",
    "@id": absoluteUrl("/#website"),
    name: input.name,
    url: absoluteUrl("/"),
    publisher: { "@type": "Organization", "@id": absoluteUrl("/#organization") },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: absoluteUrl(`${CATALOG_PATH}?${CATALOG_SEARCH_PARAM}={search_term_string}`),
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export type ModelInput = {
  creatorHandle: string;
  /** Null when the creator never set one; the handle stands in. */
  creatorDisplayName?: string | null;
  slug: string;
  /** `creator-handle/model-slug` — NOT the Hugging Face repo path. */
  modelId: string;
  displayName: string;
  description?: string | null;
  /** micro-USD per 1,000,000 tokens. Integers. */
  pricePromptMicroPerMtoken: number;
  priceCompletionMicroPerMtoken: number;
};

/** The canonical page for one model, matching `modelHref` in the marketplace. */
function modelPath(creatorHandle: string, slug: string): string {
  return `/models/${creatorHandle}/${slug}`;
}

/** The catalog filtered to one creator — a real, indexable URL. */
function creatorPath(creatorHandle: string): string {
  return `${CATALOG_PATH}?${CATALOG_CREATOR_PARAM}=${encodeURIComponent(creatorHandle)}`;
}

/**
 * One offer per metered direction.
 *
 * The rate is expressed with a `referenceQuantity` of 1,000,000 tokens rather
 * than as a per-single-token `price`, because the stored integer IS a per-1M
 * figure: quoting it per token would mean dividing it again, and a price like
 * "0.0000015" is below the precision most consumers keep. The reference
 * quantity says "per token" exactly, without touching the number.
 */
function buildOffer(name: string, microPerMtoken: number): OfferNode {
  const price = microUsdToAmount(microPerMtoken);
  return {
    "@type": "Offer",
    name,
    price,
    priceCurrency: "USD",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price,
      priceCurrency: "USD",
      referenceQuantity: {
        "@type": "QuantitativeValue",
        value: 1_000_000,
        unitText: "tokens",
      },
    },
  };
}

export function buildModelApplication(input: ModelInput): ModelApplicationNode {
  const url = absoluteUrl(modelPath(input.creatorHandle, input.slug));
  const description = input.description?.replace(/\s+/g, " ").trim();

  return {
    "@context": CONTEXT,
    "@type": "SoftwareApplication",
    "@id": url,
    name: input.displayName,
    url,
    identifier: input.modelId,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any — served over an HTTP API",
    // Absent, not `undefined`: a missing description must not serialize as a key
    // with no value, which is neither valid JSON-LD nor honest.
    ...(description ? { description } : {}),
    author: {
      "@type": "Person",
      name: input.creatorDisplayName?.trim() || input.creatorHandle,
      url: absoluteUrl(creatorPath(input.creatorHandle)),
    },
    offers: [
      buildOffer("Input tokens", input.pricePromptMicroPerMtoken),
      buildOffer("Output tokens", input.priceCompletionMicroPerMtoken),
    ],
  };
}

export type ModelBreadcrumbInput = {
  creatorHandle: string;
  creatorDisplayName?: string | null;
  slug: string;
  displayName: string;
};

/** Catalog -> creator -> model, for the `/models/[creator]/[slug]` route. */
export function buildModelBreadcrumbs(input: ModelBreadcrumbInput): BreadcrumbListNode {
  const url = absoluteUrl(modelPath(input.creatorHandle, input.slug));

  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumbs`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Models", item: absoluteUrl(CATALOG_PATH) },
      {
        "@type": "ListItem",
        position: 2,
        name: input.creatorDisplayName?.trim() || input.creatorHandle,
        item: absoluteUrl(creatorPath(input.creatorHandle)),
      },
      { "@type": "ListItem", position: 3, name: input.displayName, item: url },
    ],
  };
}

/**
 * The exact string that goes inside `<script type="application/ld+json">`.
 *
 * THE `<` ESCAPE IS A SECURITY BOUNDARY, NOT A FORMALITY. A script element's
 * content is raw text: the HTML parser does not decode entities inside it and
 * stops only at `</script`. A model description is creator-supplied, so a
 * creator who names a model `</script><img src=x onerror=…>` would otherwise
 * close the tag from inside the JSON and land arbitrary markup in the document.
 * Escaping `<` to its JSON `\u003c` form makes that impossible while leaving the
 * parsed value byte-identical — `JSON.parse` hands the original `<` back.
 *
 * `&` needs no escaping for the same reason `<` does: entities are not decoded
 * in raw text, so an ampersand cannot start one here.
 */
export function jsonLdScriptContent(node: JsonLdNode): string {
  return JSON.stringify(node).replaceAll("<", "\\u003c");
}
