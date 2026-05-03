/**
 * Always-on aggregate counters via Workers Analytics Engine.
 * Spec: docs/tech-spec.md §6.7 ("Always-on aggregate counters").
 *
 * Counters emitted on every request (UNSAMPLED — unlike `logger.ts`):
 *   - requests_total{client_id, status, cache_status, pipeline_stage}
 *   - worker_duration_ms histogram by {client_id, cache_status}
 *   - origin_duration_ms histogram by {client_id}
 *   - bytes_out histogram by {client_id, content_type_class}
 *
 * SLOs (cache hit ratio, p95 latency, error rate from PRD §10) MUST be
 * computed from these data points, not from the sampled log stream.
 *
 * **Schema (single data point per request)** — query against this when
 * building dashboards. Order is part of the contract; do NOT reorder.
 *
 *   indexes[0] = client_id
 *   blob1 = client_id
 *   blob2 = pipeline_stage
 *   blob3 = cache_status
 *   blob4 = content_type_class
 *   double1 = status                       (HTTP status code)
 *   double2 = worker_duration_ms
 *   double3 = origin_duration_ms (-1 if N/A — cache hit / 404 / etc.)
 *   double4 = bytes_out
 *
 * Open question (deferred): single dataset vs one dataset per metric
 * family. Single dataset chosen for now — cardinality is bounded by
 * client_id × pipeline_stage × cache_status, which is small.
 */

import type { Env } from "../env.js";

/** Sentinel for `origin_duration_ms` when the origin was not contacted. */
export const NO_ORIGIN_DURATION_SENTINEL = -1;

export interface RequestCounter {
  client_id: string;
  status: number;
  cache_status: "hit" | "miss" | "bypass" | "skip";
  pipeline_stage: string;
  worker_duration_ms: number;
  /** null when the origin was not contacted (cache hit, 404, etc.). */
  origin_duration_ms: number | null;
  bytes_out: number;
  content_type_class: string;
}

/**
 * Emit one Analytics Engine data point per request.
 *
 * Best-effort: Analytics Engine writes never break the request path.
 * Any error from `writeDataPoint` is swallowed.
 *
 * @param env Worker bindings (METRICS analytics dataset)
 * @param counter the per-request counter values
 * @returns void
 * @throws never
 */
export function emitRequestCounter(env: Env, counter: RequestCounter): void {
  try {
    env.METRICS.writeDataPoint({
      indexes: [counter.client_id],
      blobs: [
        counter.client_id,
        counter.pipeline_stage,
        counter.cache_status,
        counter.content_type_class,
      ],
      doubles: [
        counter.status,
        counter.worker_duration_ms,
        counter.origin_duration_ms ?? NO_ORIGIN_DURATION_SENTINEL,
        counter.bytes_out,
      ],
    });
  } catch {
    // Best-effort; never let metrics break the response.
  }
}
