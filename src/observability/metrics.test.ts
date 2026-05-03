import type { AnalyticsEngineDataPoint, AnalyticsEngineDataset } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import { NO_ORIGIN_DURATION_SENTINEL, type RequestCounter, emitRequestCounter } from "./metrics.js";

interface MetricsCapture {
  env: Env;
  points: AnalyticsEngineDataPoint[];
}

function makeMetricsEnv(): MetricsCapture {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset = {
    writeDataPoint: (point: AnalyticsEngineDataPoint): void => {
      points.push(point);
    },
  } as unknown as AnalyticsEngineDataset;
  const env = { METRICS: dataset } as unknown as Env;
  return { env, points };
}

const SAMPLE: RequestCounter = {
  client_id: "lantern-crest",
  status: 200,
  cache_status: "miss",
  pipeline_stage: "proxy",
  worker_duration_ms: 12,
  origin_duration_ms: 87,
  bytes_out: 1024,
  content_type_class: "html",
};

describe("emitRequestCounter", () => {
  it("writes one data point per call", () => {
    const cap = makeMetricsEnv();
    emitRequestCounter(cap.env, SAMPLE);
    expect(cap.points).toHaveLength(1);
  });

  it("places client_id in indexes[0] and as blob1", () => {
    const cap = makeMetricsEnv();
    emitRequestCounter(cap.env, SAMPLE);
    const point = cap.points[0];
    if (!point) throw new Error("expected one point");
    expect(point.indexes?.[0]).toBe("lantern-crest");
    expect(point.blobs?.[0]).toBe("lantern-crest");
  });

  it("orders blobs as [client_id, pipeline_stage, cache_status, content_type_class]", () => {
    const cap = makeMetricsEnv();
    emitRequestCounter(cap.env, SAMPLE);
    const point = cap.points[0];
    if (!point) throw new Error("expected one point");
    expect(point.blobs).toEqual(["lantern-crest", "proxy", "miss", "html"]);
  });

  it("orders doubles as [status, worker_duration, origin_duration, bytes_out]", () => {
    const cap = makeMetricsEnv();
    emitRequestCounter(cap.env, SAMPLE);
    const point = cap.points[0];
    if (!point) throw new Error("expected one point");
    expect(point.doubles).toEqual([200, 12, 87, 1024]);
  });

  it("encodes null origin_duration_ms as the sentinel value", () => {
    const cap = makeMetricsEnv();
    emitRequestCounter(cap.env, { ...SAMPLE, origin_duration_ms: null });
    const point = cap.points[0];
    if (!point) throw new Error("expected one point");
    expect(point.doubles?.[2]).toBe(NO_ORIGIN_DURATION_SENTINEL);
  });

  it("swallows AnalyticsEngine write errors (best-effort)", () => {
    const dataset = {
      writeDataPoint: vi.fn(() => {
        throw new Error("AE quota exceeded");
      }),
    } as unknown as AnalyticsEngineDataset;
    const env = { METRICS: dataset } as unknown as Env;
    expect(() => emitRequestCounter(env, SAMPLE)).not.toThrow();
  });
});
