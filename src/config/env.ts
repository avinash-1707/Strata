import * as z from "zod";

import { StrataError } from "../errors.js";

/**
 * Deliberately generous: the target has no GPU, so a CPU-bound 3B generation can
 * take tens of seconds and a GPU-tuned timeout would fail constantly (DD-028).
 * This bounds one call; it is not a latency target.
 */
const DEFAULT_OLLAMA_TIMEOUT_MS = 60_000;

/** 32 hex chars ≈ 128 bits, past guessable for a LAN-exposed endpoint (DD-026). */
const MIN_AUTH_TOKEN_LENGTH = 32;

const booleanFromEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  POSTGRES_URL: z.string().min(1, "must be a Postgres connection URL"),
  REDIS_URL: z.string().min(1, "must be a Redis connection URL"),
  // The protocol constraint is load-bearing: bare `z.url()` accepts
  // "localhost:11434", parsing "localhost:" as the scheme.
  OLLAMA_URL: z.url({
    protocol: /^https?$/,
    error: "must be an absolute http(s) URL, e.g. http://ollama:11434",
  }),

  EMBEDDING_MODEL: z.string().min(1),
  INSTRUCT_MODEL: z.string().min(1),

  OLLAMA_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OLLAMA_TIMEOUT_MS),

  // Optional because it is load-bearing only under the HTTP transport; stdio over
  // SSH has no HTTP surface to authenticate (DD-026). Phase 12 enforces presence
  // when HTTP mode is enabled.
  MCP_AUTH_TOKEN: z
    .string()
    .min(
      MIN_AUTH_TOKEN_LENGTH,
      `must be at least ${String(MIN_AUTH_TOKEN_LENGTH)} characters`,
    )
    .optional(),

  // Compaction is destructive and LLM-driven, so it ships off (DD-012).
  COMPACTION_ENABLED: booleanFromEnv.default(false),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

/**
 * Hand-rolled rather than using a pretty-printer because the contract is specific
 * and tested: a misconfiguration must be diagnosable from the message alone.
 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `  ${key}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Throws rather than returning a result: a misconfigured server must refuse to
 * start, not boot and fail on the first tool call, where the failure reaches the
 * agent as a confusing tool error instead of an obvious boot failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    throw new StrataError(
      "CONFIG_INVALID",
      `Invalid configuration:\n${formatIssues(result.error)}`,
      { details: { keys: result.error.issues.map((i) => i.path.join(".")) } },
    );
  }

  // Frozen so no later module can make behavior depend on call order.
  return Object.freeze(result.data);
}
