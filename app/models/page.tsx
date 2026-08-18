import { redirect } from "next/navigation";

/**
 * `/models` is the catalog, and the catalog lives at `/`.
 *
 * A permanent redirect rather than a second copy of the grid: two URLs rendering
 * the same list would split whatever ranking the catalog earns and would need
 * their canonicals kept in step forever.
 */
export default function ModelsIndex() {
  redirect("/");
}
