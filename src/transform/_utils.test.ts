import { describe, expect, it } from "vitest";

import {
  escapeAttr,
  escapeScriptClose,
  injectMarker,
  mutateJsonLdCanonical,
  stableHash,
} from "./_utils.js";

describe("stableHash", () => {
  it("produces a deterministic 8-character hex string", () => {
    expect(stableHash("foo")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces the same hash for the same input across calls", () => {
    expect(stableHash("schema:^/blog:Article:{}")).toBe(stableHash("schema:^/blog:Article:{}"));
  });

  it("produces different hashes for different inputs", () => {
    expect(stableHash("a")).not.toBe(stableHash("b"));
    expect(stableHash("schema:x")).not.toBe(stableHash("schema:y"));
  });

  it("handles the empty string", () => {
    expect(stableHash("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles unicode input", () => {
    expect(stableHash("café — über")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("escapeAttr", () => {
  it("escapes the four attribute-breaking characters", () => {
    expect(escapeAttr('<>&"')).toBe("&lt;&gt;&amp;&quot;");
  });

  it("leaves safe characters untouched", () => {
    expect(escapeAttr("https://example.com/path?q=1#frag")).toBe(
      "https://example.com/path?q=1#frag",
    );
  });

  it("escapes & before other entities so it doesn't double-encode", () => {
    expect(escapeAttr('Tom & Jerry "show"')).toBe("Tom &amp; Jerry &quot;show&quot;");
  });
});

describe("injectMarker", () => {
  it("injects data-edge-seo-rule into the first opening tag", () => {
    expect(injectMarker('<div class="x">hello</div>', "abc123ef")).toBe(
      '<div class="x" data-edge-seo-rule="abc123ef">hello</div>',
    );
  });

  it("handles a self-closing tag", () => {
    expect(injectMarker('<img src="x.png" alt="x"/>', "abc123ef")).toBe(
      '<img src="x.png" alt="x" data-edge-seo-rule="abc123ef"/>',
    );
  });

  it("handles a tag with no attributes", () => {
    expect(injectMarker("<section>body</section>", "abc123ef")).toBe(
      '<section data-edge-seo-rule="abc123ef">body</section>',
    );
  });

  it("preserves leading whitespace before the tag", () => {
    expect(injectMarker("\n  <div>x</div>", "abc123ef")).toBe(
      '\n  <div data-edge-seo-rule="abc123ef">x</div>',
    );
  });

  it("wraps non-tag content in a display:contents marker span", () => {
    expect(injectMarker("just text", "abc123ef")).toBe(
      '<span data-edge-seo-rule="abc123ef" style="display:contents">just text</span>',
    );
  });
});

describe("escapeScriptClose", () => {
  it("escapes a literal </script> sequence", () => {
    expect(escapeScriptClose('{"x":"</script>"}')).toBe('{"x":"<\\/script>"}');
  });

  it("is case-insensitive on the tag name", () => {
    expect(escapeScriptClose("</SCRIPT")).toBe("<\\/SCRIPT");
    expect(escapeScriptClose("</Script")).toBe("<\\/Script");
  });

  it("leaves unrelated angle brackets untouched", () => {
    expect(escapeScriptClose("a < b > c </span>")).toBe("a < b > c </span>");
  });

  it("escapes multiple occurrences", () => {
    expect(escapeScriptClose("</script></script>")).toBe("<\\/script><\\/script>");
  });

  it("round-trips through JSON.parse semantically", () => {
    const payload = { quote: "abc</script>def" };
    const escaped = escapeScriptClose(JSON.stringify(payload));
    expect(JSON.parse(escaped)).toEqual(payload);
  });
});

describe("mutateJsonLdCanonical", () => {
  it("updates top-level url", () => {
    const node = { "@context": "https://schema.org", "@type": "Article", url: "OLD" };
    mutateJsonLdCanonical(node, "https://canonical.example/x");
    expect(node.url).toBe("https://canonical.example/x");
  });

  it("updates top-level @id", () => {
    const node = { "@type": "Article", "@id": "OLD" } as Record<string, unknown>;
    mutateJsonLdCanonical(node, "https://canonical.example/x");
    expect(node["@id"]).toBe("https://canonical.example/x");
  });

  it("does NOT touch nested entity url (e.g., publisher.url)", () => {
    const node = {
      "@type": "Article",
      url: "OLD",
      publisher: { "@type": "Organization", url: "https://publisher.example" },
    };
    mutateJsonLdCanonical(node, "https://canonical.example/x");
    expect(node.url).toBe("https://canonical.example/x");
    expect(node.publisher.url).toBe("https://publisher.example");
  });

  it("walks arrays at the top level", () => {
    const arr = [
      { "@type": "WebPage", url: "OLD-1" },
      { "@type": "Article", url: "OLD-2" },
    ];
    mutateJsonLdCanonical(arr, "https://canonical.example/x");
    expect(arr[0]?.url).toBe("https://canonical.example/x");
    expect(arr[1]?.url).toBe("https://canonical.example/x");
  });

  it("returns scalars and null untouched", () => {
    expect(mutateJsonLdCanonical(null, "x")).toBeNull();
    expect(mutateJsonLdCanonical("string", "x")).toBe("string");
    expect(mutateJsonLdCanonical(42, "x")).toBe(42);
  });

  it("does NOT add url/@id to objects that don't already have them", () => {
    const node = { "@type": "Article", headline: "Hello" } as Record<string, unknown>;
    mutateJsonLdCanonical(node, "https://canonical.example/x");
    expect(node.url).toBeUndefined();
    expect(node["@id"]).toBeUndefined();
  });
});
