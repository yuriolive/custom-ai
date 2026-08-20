/**
 * The handful of glyphs the chat needs.
 *
 * Inline SVG rather than an icon package: this repo has no icon dependency, and
 * adding one for four shapes would put a few hundred kilobytes and a supply
 * chain behind a chevron. Each is `currentColor` so it inherits the button's
 * own state colours instead of carrying a palette of its own.
 */

type IconProps = Readonly<{ className?: string }>;

const BASE = "size-4 shrink-0";

export function ChevronUpDownIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function ArrowUpIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <rect height="10" rx="2" width="10" x="7" y="7" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M4 20h4l10-10-4-4L4 16v4Z" />
      <path d="m14 6 4 4" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M4 7h16M10 4h4M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function EllipsisIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`${BASE} ${className ?? ""}`}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
