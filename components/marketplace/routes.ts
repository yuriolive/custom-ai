/**
 * The one place a computed URL becomes a typed route.
 *
 * `next.config.ts` sets `typedRoutes: true`, so `<Link href>` and
 * `router.push()` accept only string literals TypeScript can match against the
 * generated route table. That is a real safety net for hand-written links — it
 * catches `/model/…` for `/models/…` at compile time — but it cannot type a
 * catalog URL assembled at runtime from user-supplied search params, nor
 * `/models/${handle}/${slug}` where both halves come from a database row.
 *
 * So the cast happens here, once, deliberately, instead of being scattered as
 * `as never` across every call site where it would stop being visible. Both
 * generators feeding this function build their paths from string literals
 * (`catalogHref` from `"/models"`, the model link from `"/models/"`), and both
 * target routes exist in the table: `"/models"` and
 * `"/models/[creator]/[slug]"`.
 */

import type { useRouter } from "next/navigation";

type AppRouter = ReturnType<typeof useRouter>;

/** Whatever `router.push` accepts under the current typed-routes config. */
export type AppHref = Parameters<AppRouter["push"]>[0];

/** Assert that a computed path is a real route. See the note above. */
export function appHref(path: string): AppHref {
  return path as AppHref;
}

/** The canonical page for one model. */
export function modelHref(creatorHandle: string, slug: string): AppHref {
  return appHref(`/models/${creatorHandle}/${slug}`);
}
