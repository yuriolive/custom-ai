/**
 * Unit tests for provenance copy.
 * Run: npm run test:app
 *
 * A badge that over-claims is a WORKING badge that misleads — nothing fails,
 * nothing 500s, and the only thing wrong is a word. These assertions are the
 * check on that word, and they encode the three limits issue #30 puts on it:
 *
 * 1. The badge is a statement about a REPOSITORY, never about authorship of the
 *    weights. Hugging Face sign-in proves control of an account; an org member
 *    can publish a repo they did not train.
 * 2. The third-party state is NEUTRAL. It is the ordinary condition of a
 *    marketplace and must not be worded as a warning or a deficiency.
 * 3. The badge never touches money. The copy must not imply that it does.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  provenanceDescription,
  provenanceLabel,
  provenanceNote,
  provenanceState,
} from "./provenance.ts";

/** Everything a reader could take as "this creator made the model". */
const AUTHORSHIP_CLAIMS = [
  "trained by",
  "created by",
  "author of",
  "verified author",
  "made by",
  "authored",
];

/** Everything that would turn the neutral state into an accusation. */
const DEMERIT_WORDS = [
  "unverified",
  "unofficial",
  "warning",
  "caution",
  "risk",
  "beware",
  "untrusted",
  "not verified",
  "unknown source",
];

const ALL_COPY = [true, false].flatMap((isOfficial) => [
  provenanceLabel(isOfficial),
  provenanceDescription(isOfficial),
  provenanceNote(isOfficial),
]);

test("the two states are named, and named as peers", () => {
  assert.equal(provenanceState(true), "official");
  assert.equal(provenanceState(false), "third-party");
  assert.equal(provenanceLabel(true), "official");
  assert.equal(provenanceLabel(false), "third-party");
});

test("no copy claims the creator authored the weights", () => {
  for (const copy of ALL_COPY) {
    for (const claim of AUTHORSHIP_CLAIMS) {
      assert.ok(
        !copy.toLowerCase().includes(claim),
        `provenance copy must not claim authorship, found ${JSON.stringify(claim)} in: ${copy}`,
      );
    }
  }
});

test("the official copy states the limit it is under", () => {
  // The badge is allowed to exist only because it says what it is not. If this
  // sentence goes, so does the justification for showing the badge at all.
  const stated = `${provenanceDescription(true)} ${provenanceNote(true)}`.toLowerCase();
  assert.ok(stated.includes("account"), "the official copy must name what was proven: an account");
  assert.ok(
    stated.includes("not about who trained") || stated.includes("not authorship"),
    "the official copy must say what was NOT proven",
  );
});

test("the third-party state is never worded as a demerit", () => {
  const neutral =
    `${provenanceLabel(false)} ${provenanceDescription(false)} ${provenanceNote(false)}`
      .toLowerCase()
      // "doesn't own the upstream …" is a statement of fact, not a warning; the
      // words below are what turn it into one.
      .replaceAll("doesn't own", "");
  for (const word of DEMERIT_WORDS) {
    assert.ok(!neutral.includes(word), `third-party copy must stay neutral, found: ${word}`);
  }
});

test("the third-party copy says the listing is not disadvantaged", () => {
  const note = provenanceNote(false).toLowerCase();
  assert.ok(
    note.includes("ordinary") || note.includes("normal"),
    "it must name the state as usual",
  );
  assert.ok(note.includes("same"), "it must say what does not change");
});

test("no copy ties the badge to a price, a rank or a payout", () => {
  // The one thing the badge is forbidden from doing (#30). Copy that hinted at
  // it would invite the next reader to wire it up.
  for (const copy of ALL_COPY) {
    const lowered = copy.toLowerCase();
    for (const phrase of ["discount", "cheaper", "ranked higher", "priority", "earns more"]) {
      assert.ok(!lowered.includes(phrase), `provenance copy must not touch money: ${phrase}`);
    }
  }
});

test("both states describe the same axis, so two cards are comparable", () => {
  // Whatever else changes, both sentences must be about ownership of the
  // upstream repository — otherwise a shopper is comparing a claim against a
  // shrug and reads the absence as a fault.
  for (const isOfficial of [true, false]) {
    assert.ok(
      provenanceDescription(isOfficial).toLowerCase().includes("upstream"),
      "both descriptions name the upstream repository",
    );
  }
});
