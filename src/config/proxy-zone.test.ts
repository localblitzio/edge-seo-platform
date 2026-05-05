import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROXY_ZONE,
  RESERVED_SUBDOMAINS,
  defaultProxyDomainFor,
  isDefaultProxyZone,
  subdomainOfDefaultZone,
} from "./proxy-zone.js";

describe("isDefaultProxyZone", () => {
  it("returns true for a single-label subdomain on the default zone", () => {
    expect(isDefaultProxyZone(`acme.${DEFAULT_PROXY_ZONE}`)).toBe(true);
  });

  it("returns true for a multi-label subdomain on the default zone", () => {
    expect(isDefaultProxyZone(`foo.bar.${DEFAULT_PROXY_ZONE}`)).toBe(true);
  });

  it("returns false for a different zone", () => {
    expect(isDefaultProxyZone("client.example.com")).toBe(false);
  });

  it("returns false for the bare zone (no subdomain)", () => {
    expect(isDefaultProxyZone(DEFAULT_PROXY_ZONE)).toBe(false);
  });

  it("returns false for a zone that just shares a suffix (substring trick)", () => {
    // "fakelocalpage.us.com" must not match "localpage.us.com" — the leading
    // dot in the check `endsWith(".${zone}")` defends against this.
    expect(isDefaultProxyZone(`fake${DEFAULT_PROXY_ZONE}`)).toBe(false);
  });
});

describe("defaultProxyDomainFor", () => {
  it("constructs `<id>.${zone}`", () => {
    expect(defaultProxyDomainFor("acme")).toBe(`acme.${DEFAULT_PROXY_ZONE}`);
  });

  it("does not validate the id (caller's responsibility)", () => {
    // Demonstrates the contract — invalid input still concatenates.
    expect(defaultProxyDomainFor("Bad-ID")).toBe(`Bad-ID.${DEFAULT_PROXY_ZONE}`);
  });
});

describe("subdomainOfDefaultZone", () => {
  it("returns the single leftmost label for `<id>.${zone}`", () => {
    expect(subdomainOfDefaultZone(`acme.${DEFAULT_PROXY_ZONE}`)).toBe("acme");
  });

  it("returns the full multi-label prefix unchanged", () => {
    expect(subdomainOfDefaultZone(`foo.bar.${DEFAULT_PROXY_ZONE}`)).toBe("foo.bar");
  });

  it("returns null for a non-default-zone domain", () => {
    expect(subdomainOfDefaultZone("client.example.com")).toBeNull();
  });

  it("returns null for the bare zone", () => {
    expect(subdomainOfDefaultZone(DEFAULT_PROXY_ZONE)).toBeNull();
  });
});

describe("RESERVED_SUBDOMAINS", () => {
  it("contains the obvious infrastructure labels", () => {
    for (const sub of ["www", "api", "admin", "mail", "ssl"]) {
      expect(RESERVED_SUBDOMAINS.has(sub)).toBe(true);
    }
  });

  it("does not include common client-id shapes", () => {
    for (const sub of ["acme", "lantern-crest", "client-1", "tenant42"]) {
      expect(RESERVED_SUBDOMAINS.has(sub)).toBe(false);
    }
  });

  it("uses lowercase entries (matches the tightened client_id regex)", () => {
    for (const sub of RESERVED_SUBDOMAINS) {
      expect(sub).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
