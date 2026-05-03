import { describe, expect, it } from "vitest";

import * as logShipper from "./log-shipper.js";

describe("log-shipper (placeholder)", () => {
  it("imports without side effects (Logpush is configured at deploy time)", () => {
    expect(logShipper).toBeDefined();
  });
});
