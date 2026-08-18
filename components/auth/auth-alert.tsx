"use client";

import { Alert } from "@heroui/react";

/**
 * Form-level auth message.
 *
 * HeroUI v3 `Alert` takes `status` — there is no `variant` and no `color` on
 * Alert — and Title/Description must live inside `Alert.Content` (PRD §4.1.0).
 *
 * `role="alert"` + `aria-live` so a screen reader announces a failed submit
 * without the user having to hunt for what changed.
 */
export function AuthAlert({
  status,
  title,
  description,
}: {
  status: "danger" | "success" | "warning" | "accent";
  title: string;
  description?: string;
}) {
  return (
    <Alert aria-live="polite" role="alert" status={status}>
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        {description ? <Alert.Description>{description}</Alert.Description> : null}
      </Alert.Content>
    </Alert>
  );
}
