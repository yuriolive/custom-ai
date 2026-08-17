import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The scaffold owns only app/, components/ and lib/. Other agents own
  // packages/, tools/, supabase/ and tests/ — keep the Next build out of them.
  outputFileTracingExcludes: {
    "*": ["./packages/**", "./tools/**", "./supabase/**", "./tests/**"],
  },
  eslint: {
    dirs: ["app", "components", "lib"],
  },
  typedRoutes: true,
};

export default nextConfig;
