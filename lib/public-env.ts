/**
 * Client-safe environment. Everything here is inlined into the browser bundle
 * at build time, so every member must be non-secret by construction.
 *
 * `npm run check:env` fails the build if a NEXT_PUBLIC_* variable ever carries
 * a credential-shaped name or value.
 *
 * Next.js only inlines `process.env.NEXT_PUBLIC_X` when it is written as a full
 * static member expression — never index it dynamically.
 */
export const publicEnv = {
  defaultModel:
    process.env.NEXT_PUBLIC_DEFAULT_MODEL ??
    "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",

  /**
   * Honest cold-start estimate, in seconds. The MVP-0 target model wakes a
   * scale-to-zero llama.cpp worker; measured cold start is ~100 s.
   */
  coldStartEstimateSeconds: Number(
    process.env.NEXT_PUBLIC_COLD_START_ESTIMATE_SECONDS ?? "100",
  ),
} as const;
