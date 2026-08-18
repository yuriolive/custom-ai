"use client";

import { Button, Dropdown, Spinner } from "@heroui/react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { signOutAction } from "@/app/(auth)/actions";

/**
 * Signed-in nav control: the immutable profile handle plus a menu.
 *
 * The handle is assigned by the `on_auth_user_created` trigger and is immutable
 * by RLS (CONTRACTS.md) — display it, never offer to edit it.
 *
 * `onPress` / `onAction`, never `onClick`: HeroUI v3 is React Aria and the
 * ESLint rule `heroui/no-onclick` fails the build on the v2 spelling.
 */
export function UserMenu({ handle }: { handle: string }) {
  const router = useRouter();
  const [isSigningOut, startSignOut] = useTransition();

  function onAction(key: React.Key) {
    if (key === "sign-out") {
      startSignOut(async () => {
        // Server Action: clears the cookie, revalidates the layout so this nav
        // re-renders signed-out, and redirects to /.
        await signOutAction();
      });
      return;
    }
    router.push(String(key) as Route);
  }

  return (
    <Dropdown>
      <Dropdown.Trigger>
        <Button
          aria-label={`Account menu for ${handle}`}
          isDisabled={isSigningOut}
          size="sm"
          variant="outline"
        >
          {isSigningOut ? <Spinner size="sm" /> : null}
          <span className="max-w-[10rem] truncate">
            {isSigningOut ? "Signing out…" : handle}
          </span>
        </Button>
      </Dropdown.Trigger>

      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Account" onAction={onAction}>
          <Dropdown.Item id="/console">Console</Dropdown.Item>
          <Dropdown.Item id="/playground">Playground</Dropdown.Item>
          <Dropdown.Item id="sign-out">Sign out</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
