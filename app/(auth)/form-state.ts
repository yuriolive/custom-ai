/**
 * Shape and initial value for every auth form's `useActionState`.
 *
 * This lives OUTSIDE `actions.ts` because a `"use server"` module may only
 * export async functions — Next.js validates every export of an action file at
 * request time and throws
 *
 *   Error: A "use server" file can only export async functions, found object.
 *
 * on anything else. A `type` export is erased at compile time and would be
 * fine; the `initialAuthFormState` *object* is not, so both live here and
 * `actions.ts` imports the type from this module.
 */

export type AuthFormState = {
  status: "idle" | "error" | "check-email";
  /** User-facing copy. Never a raw provider message. */
  message?: string;
  /** Field the message belongs to, when it belongs to one. */
  field?: "email" | "password";
  /** Echoed so a failed submit does not wipe what the user typed. */
  email?: string;
};

export const initialAuthFormState: AuthFormState = { status: "idle" };
