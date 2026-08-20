/**
 * Shape and initial value for the moderation forms' `useActionState`.
 *
 * Lives OUTSIDE `actions.ts` for the same reason `app/(auth)/form-state.ts`
 * does: a `"use server"` module may only export async functions, and Next
 * validates every export at request time. A `type` would be erased and would be
 * fine; the `initialOperatorFormState` *object* would not.
 */

export type OperatorFormState = {
  status: "idle" | "done" | "error";
  /** User-facing copy. Never a raw Postgres message. */
  message?: string;
  /** Which report the outcome belongs to, so one row's error stays on that row. */
  reportId?: string;
};

export const initialOperatorFormState: OperatorFormState = { status: "idle" };
