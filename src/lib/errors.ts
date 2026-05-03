/**
 * Error classes used across the Worker pipeline.
 * Spec: docs/tech-spec.md §8.
 *
 * The top-level handler in src/worker.ts maps each class to a status code.
 * Throw these instead of generic `Error` whenever the cause is one of the
 * defined failure modes — the mapping is part of the contract.
 */

export class ConfigNotFoundError extends Error {
  override readonly name = "ConfigNotFoundError";
}

export class ConfigValidationError extends Error {
  override readonly name = "ConfigValidationError";

  constructor(
    message: string,
    /** Underlying validation error (e.g., a ZodError). Not logged verbatim. */
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class OriginFetchError extends Error {
  override readonly name = "OriginFetchError";

  constructor(
    public readonly origin: string,
    public override readonly cause: unknown,
  ) {
    super(`Origin fetch failed: ${origin}`);
  }
}

export class RedirectLoopError extends Error {
  override readonly name = "RedirectLoopError";
}

export class TransformError extends Error {
  override readonly name = "TransformError";
}
