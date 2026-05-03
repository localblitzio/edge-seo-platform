import { describe, expect, it } from "vitest";

import {
  ConfigNotFoundError,
  ConfigValidationError,
  OriginFetchError,
  RedirectLoopError,
  TransformError,
} from "./errors.js";

describe("error classes", () => {
  it("each error has a stable name", () => {
    expect(new ConfigNotFoundError("x").name).toBe("ConfigNotFoundError");
    expect(new ConfigValidationError("x").name).toBe("ConfigValidationError");
    expect(new OriginFetchError("https://example.com", new Error()).name).toBe("OriginFetchError");
    expect(new RedirectLoopError("x").name).toBe("RedirectLoopError");
    expect(new TransformError("x").name).toBe("TransformError");
  });

  it("OriginFetchError captures origin and cause", () => {
    const cause = new Error("ENOTFOUND");
    const err = new OriginFetchError("https://origin.example", cause);
    expect(err.origin).toBe("https://origin.example");
    expect(err.cause).toBe(cause);
  });
});
