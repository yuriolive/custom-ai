"use client";

import { Dropdown, Spinner } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
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
      {/* `Dropdown.Trigger` IS the button (a React Aria `Button`), so the
          content goes directly inside it. Nesting a HeroUI `<Button>` here
          renders `<button><button>` — invalid HTML, and the inner button
          swallows the press before the menu ever opens. `buttonVariants`
          gives the trigger the same look without the second element. */}
      <Dropdown.Trigger
        aria-label={`Account menu for ${handle}`}
        className={buttonVariants({ size: "sm", variant: "outline" })}
        isDisabled={isSigningOut}
      >
        {isSigningOut ? <Spinner size="sm" /> : null}
        <span className="max-w-[5rem] truncate sm:max-w-[10rem]">
          {isSigningOut ? "Signing out…" : handle}
        </span>
      </Dropdown.Trigger>

      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Account" onAction={onAction}>
          <Dropdown.Item id="/chat">Chat</Dropdown.Item>
          <Dropdown.Item id="/console">Console</Dropdown.Item>
          <Dropdown.Item id="/playground">Playground</Dropdown.Item>
          <Dropdown.Item id="sign-out">Sign out</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
