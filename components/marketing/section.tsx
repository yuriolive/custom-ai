/**
 * The landing page's section rhythm, as one primitive.
 *
 * Measured off resend.com (docs/UI-REDESIGN-PLAN.md §2.5): every section is
 * **display heading → one muted sentence → a product artifact**. Never an
 * illustration. The discipline is the point — a page where each section
 * announces itself the same way reads as one document, and a page where each
 * section invents its own header reads as a template.
 *
 * Server Component, plain markup, no `@heroui/react` — so a page composed of
 * these stays server-rendered and indexable (FR-MKT-006).
 */
export function Section({
  eyebrow,
  title,
  lede,
  children,
  id,
  className,
}: Readonly<{
  /** Small tracked label above the heading. The `eyebrow` role, DESIGN.md §2.2. */
  eyebrow?: string;
  title: string;
  lede?: string;
  children?: React.ReactNode;
  id?: string;
  className?: string;
}>) {
  // A heading needs an id for `aria-labelledby`, and the section needs to be
  // linkable. One id serves both rather than inventing a second.
  const headingId = id ? `${id}-title` : undefined;

  return (
    <section
      aria-labelledby={headingId}
      className={["flex flex-col gap-8 py-16 sm:py-24", className ?? ""].join(" ")}
      id={id}
    >
      <div className="flex max-w-2xl flex-col gap-4">
        {eyebrow ? (
          <span className="text-accent font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
            {eyebrow}
          </span>
        ) : null}

        <h2
          className="text-2xl leading-[1.15] font-semibold tracking-[-0.03em] sm:text-3xl"
          id={headingId}
        >
          {title}
        </h2>

        {lede ? <p className="text-muted text-base leading-[1.65]">{lede}</p> : null}
      </div>

      {children}
    </section>
  );
}

/**
 * The page container. `max-w-6xl` rather than Modal's 1400px: our type is Inter
 * at 400/500 with no display face (DESIGN.md §4 item 1), and a measure that wide
 * makes a paragraph hard to track back to the next line.
 */
export function MarketingContainer({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>) {
  return (
    <div className={["mx-auto w-full max-w-6xl px-4 sm:px-6", className ?? ""].join(" ")}>
      {children}
    </div>
  );
}
