"use client";

import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";

/**
 * Signed-out nav control. A HeroUI Button (React Aria `<button>`) driven by the
 * router, so it matches the signed-in control visually and keeps client-side
 * navigation.
 */
export function SignInLink() {
  const router = useRouter();

  return (
    <Button onPress={() => router.push("/login")} size="sm" variant="primary">
      Sign in
    </Button>
  );
}
