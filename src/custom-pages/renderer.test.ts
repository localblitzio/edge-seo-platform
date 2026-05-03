import { describe, expect, it } from "vitest";

import { buildHtmlResponse, buildNotFoundResponse } from "./renderer.js";

describe("buildHtmlResponse", () => {
  it("returns a 200 HTML response with the body", async () => {
    const response = buildHtmlResponse("<html>hello</html>");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<html>hello</html>");
  });

  it("passes ETag through when provided", () => {
    const response = buildHtmlResponse("<html></html>", '"abc123"');
    expect(response.headers.get("etag")).toBe('"abc123"');
  });

  it("passes Last-Modified through when provided", () => {
    const date = new Date("2026-01-15T10:00:00Z");
    const response = buildHtmlResponse("<html></html>", undefined, date);
    expect(response.headers.get("last-modified")).toBe(date.toUTCString());
  });

  it("emits both validators when both provided", () => {
    const date = new Date("2026-01-15T10:00:00Z");
    const response = buildHtmlResponse("<html></html>", '"x"', date);
    expect(response.headers.get("etag")).toBe('"x"');
    expect(response.headers.get("last-modified")).toBe(date.toUTCString());
  });

  it("emits neither validator when not provided", () => {
    const response = buildHtmlResponse("<html></html>");
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("last-modified")).toBe(false);
  });
});

describe("buildNotFoundResponse", () => {
  it("returns a 404 plain-text response", async () => {
    const response = buildNotFoundResponse();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Not Found");
  });
});
