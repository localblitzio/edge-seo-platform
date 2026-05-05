/**
 * Unit tests for the text-rewriter transform. Real HTMLRewriter
 * behavior (actual element content swapping) is exercised via
 * integration tests against Miniflare/workerd; here we mock the
 * rewriter to assert match-skip and match-attach behavior at the
 * `.on()` call layer.
 */

import { describe, expect, it, vi } from "vitest";

import type { TextRewriteRule } from "../config/schema.js";
import { attachTextRewrites } from "./text-rewriter.js";

interface MockRewriter {
  on: ReturnType<typeof vi.fn>;
}

function mockRewriter(): MockRewriter {
  return { on: vi.fn() };
}

describe("attachTextRewrites", () => {
  it("registers a handler for each rule whose match regex matches the path", () => {
    const r = mockRewriter();
    const rules: TextRewriteRule[] = [
      { match: "^/$", selector: "h1", mode: "text", content: "Home Title" },
      { match: "^/about", selector: "h1", mode: "text", content: "About Title" },
    ];
    attachTextRewrites(r as unknown as HTMLRewriter, "/", rules);
    expect(r.on).toHaveBeenCalledTimes(1);
    expect(r.on).toHaveBeenCalledWith("h1", expect.any(Object));
  });

  it("skips rules whose match regex does not match the path", () => {
    const r = mockRewriter();
    const rules: TextRewriteRule[] = [
      { match: "^/blog/.*", selector: "h2", mode: "text", content: "Blog Title" },
    ];
    attachTextRewrites(r as unknown as HTMLRewriter, "/", rules);
    expect(r.on).not.toHaveBeenCalled();
  });

  it("attaches multiple handlers when multiple rules match", () => {
    const r = mockRewriter();
    const rules: TextRewriteRule[] = [
      { match: "^/.*", selector: "h1", mode: "text", content: "A" },
      { match: "^/.*", selector: "h2.hero", mode: "text", content: "B" },
      { match: "^/.*", selector: "p", mode: "html", content: "<em>C</em>" },
    ];
    attachTextRewrites(r as unknown as HTMLRewriter, "/anywhere", rules);
    expect(r.on).toHaveBeenCalledTimes(3);
    expect(r.on).toHaveBeenNthCalledWith(1, "h1", expect.any(Object));
    expect(r.on).toHaveBeenNthCalledWith(2, "h2.hero", expect.any(Object));
    expect(r.on).toHaveBeenNthCalledWith(3, "p", expect.any(Object));
  });

  it("element handler calls setInnerContent with html=false for mode=text", () => {
    const r = mockRewriter();
    const rules: TextRewriteRule[] = [
      { match: "^/.*", selector: "h1", mode: "text", content: "Hello <world>" },
    ];
    attachTextRewrites(r as unknown as HTMLRewriter, "/", rules);
    const handler = r.on.mock.calls[0]?.[1] as { element: (el: unknown) => void };
    const setInnerContent = vi.fn();
    handler.element({ setInnerContent } as never);
    expect(setInnerContent).toHaveBeenCalledWith("Hello <world>", { html: false });
  });

  it("element handler calls setInnerContent with html=true for mode=html", () => {
    const r = mockRewriter();
    const rules: TextRewriteRule[] = [
      { match: "^/.*", selector: "h1", mode: "html", content: "<em>Hello</em>" },
    ];
    attachTextRewrites(r as unknown as HTMLRewriter, "/", rules);
    const handler = r.on.mock.calls[0]?.[1] as { element: (el: unknown) => void };
    const setInnerContent = vi.fn();
    handler.element({ setInnerContent } as never);
    expect(setInnerContent).toHaveBeenCalledWith("<em>Hello</em>", { html: true });
  });

  it("does nothing when the rules array is empty", () => {
    const r = mockRewriter();
    attachTextRewrites(r as unknown as HTMLRewriter, "/", []);
    expect(r.on).not.toHaveBeenCalled();
  });
});
