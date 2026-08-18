import Link from "next/link";

/**
 * The 404 for a model URL.
 *
 * It exists to answer the question the visitor actually has, which is almost
 * never "does this page exist". Overwhelmingly they pasted a Hugging Face repo
 * path where a platform model id belongs — the single most common failure in this
 * product — so the copy names that possibility first and points at the catalog,
 * where the real id is one click away.
 */
export default function ModelNotFound() {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">No such model</h1>

      <p className="text-muted text-sm">
        Either it does not exist, it is private, or it has not finished deploying.
      </p>

      <div className="border-muted/25 bg-surface flex flex-col gap-2 rounded-[var(--radius)] border p-4">
        <p className="text-sm font-medium">The most likely cause: a Hugging Face repo path</p>
        <p className="text-muted text-sm">
          A model here is addressed by its <em>platform</em> id —{" "}
          <code className="text-foreground">creator-handle/model-slug</code>, lowercase. The creator
          handle is an identity on this platform, which need not match the Hugging Face account, and
          the slug is chosen when the model is registered. So the repo path a model was built from is
          usually a different string, and a different string is a 404.
        </p>
        <p className="text-muted text-sm">
          Case is <strong>not</strong> the problem — both this page and the gateway lowercase what
          they are given. The names are. Open the model from the catalog and copy the id off its page
          rather than retyping the repo path.
        </p>
      </div>

      <Link className="text-accent text-sm font-medium hover:underline" href="/">
        Browse the catalog →
      </Link>
    </div>
  );
}
