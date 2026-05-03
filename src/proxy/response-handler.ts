/**
 * Convert raw upstream responses into pipeline-ready responses.
 * Spec: docs/tech-spec.md §6.5 step 10 and §5 step 8.
 *
 * STATUS: M7.
 *
 * Responsibilities:
 *   - Sniff content-type to decide whether HTMLRewriter applies.
 *   - On origin 5xx, surface enough context for the worker to serve a
 *     stale-while-error response (§9 invariant 4).
 */

export {};
