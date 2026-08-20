/**
 * Hugging Face namespaces — the string handling behind the `official` badge
 * (GitHub #30).
 *
 * A "namespace" is the first segment of an HF path: the user or org that owns a
 * repo. `JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` sits in the namespace
 * `jonathancoletti`.
 *
 * ONE RULE MATTERS HERE and it is easy to get subtly wrong: HF paths are
 * **case-preserving and case-insensitive**. The Hub serves `Qwen/Qwen3-8B` and
 * `qwen/qwen3-8b` as the same repo, and `preferred_username` comes back in
 * whatever case the account chose. Comparing raw strings would deny the badge
 * to the very accounts most likely to earn it — org names on the Hub are
 * overwhelmingly capitalised (`Qwen`, `NousResearch`, `TheBloke`) while
 * `base_models.slug` is lowercase by schema CHECK.
 *
 * So everything is lowercased ON THE WAY IN, once, at sign-in. The database
 * column carries the same CHECK as `HF_NAMESPACE` below, and the SQL rule that
 * actually decides the badge (`public.listing_is_official`) compares
 * already-normalized values. This module is the writer's half of that contract,
 * not a second implementation of the rule.
 */

/**
 * A syntactically valid, already-lowercased HF namespace.
 *
 * Byte-identical to the CHECK on `hf_identities.username` and to the predicate
 * in `public.hf_namespaces_valid`. If one moves, the other two are wrong: a
 * value this accepts and the column rejects is a sign-in that 500s on write.
 */
const HF_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * Lowercase and validate a single namespace, or `null` if it is not one.
 *
 * `null` rather than a thrown error, because every caller here is on a sign-in
 * path where a malformed value must cost a badge and never a login.
 */
export function normalizeHfNamespace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return HF_NAMESPACE.test(normalized) ? normalized : null;
}

/**
 * The owner segment of an HF repo path, normalized.
 *
 * Rejects a bare name with no `/`: `qwen3-8b` names no owner, and treating it as
 * one would let a listing with a malformed `hf_repo_slug` match a creator whose
 * username happened to equal the model name.
 */
export function hfRepoOwner(repoPath: unknown): string | null {
  if (typeof repoPath !== "string") return null;
  const slash = repoPath.indexOf("/");
  if (slash <= 0) return null;
  return normalizeHfNamespace(repoPath.slice(0, slash));
}

/**
 * Normalize a list of namespaces: lowercase, drop anything malformed, dedupe,
 * and sort so the stored array is stable.
 *
 * Sorted because the column is compared by eye in support tickets and diffed in
 * fixtures, and an org list whose order follows the Hub's response ordering
 * churns for no reason. `toSorted` rather than `sort` — `no-array-sort` is
 * enforced in CI, and mutating an argument-derived array is how that rule earns
 * its keep.
 */
export function normalizeHfNamespaces(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeHfNamespace(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen].toSorted(compareNamespaces);
}

/**
 * Code-point order, explicitly, and NOT `localeCompare`.
 *
 * A comparator is required rather than optional: `toSorted()` with no argument
 * sorts by the elements' *string conversion*, which is a real defect waiting for
 * the first non-ASCII input even though every value reaching it here has already
 * been narrowed to `[a-z0-9._-]`.
 *
 * `localeCompare` is the usual suggestion and is the wrong one for this array.
 * Its ordering comes from ICU and therefore from the runtime's default locale,
 * which makes the stored value a function of the machine that wrote it — two
 * servers could persist the same org list in two orders, and the fixture diffs
 * this sort exists to keep quiet would start moving again. Code-point order is
 * the same everywhere.
 */
function compareNamespaces(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
