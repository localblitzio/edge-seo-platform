/**
 * Known secret slots — the fixed set of keys the platform reads.
 *
 * The Settings → API keys admin page only exposes slots defined here;
 * the Worker only reads slots defined here. Adding a new integration
 * means adding a slot row + the consumer that reads it via
 * `getSecret(env, slot.key)`.
 *
 * Slot keys mirror the historical Worker-secret names so existing
 * `wrangler secret put`-bound values remain readable as a fallback
 * (see `src/secrets/store.ts`).
 */

export interface SecretSlot {
  /** Unique storage key. Mirrors the legacy Worker-secret name when one exists. */
  key: string;
  /** Display label for the UI ("IndexNow API key"). */
  label: string;
  /** One-paragraph description of what consumes this key + when to set it. */
  description: string;
  /**
   * If true, the value is multi-line (e.g. JSON blobs like a GSC service
   * account). UI renders a textarea; otherwise a password input.
   */
  multiline?: boolean;
  /** External docs link the operator can follow to obtain this value. */
  docs_url?: string;
}

export const SECRET_SLOTS: readonly SecretSlot[] = [
  {
    key: "INDEXNOW_KEY",
    label: "IndexNow API key",
    description:
      "Used to ping Bing/Yandex/Seznam when a site config changes, and to serve the per-domain verification file at /<key>.txt. 8-128 hex-ish chars; generate one at https://www.bing.com/indexnow.",
    docs_url: "https://www.indexnow.org/documentation",
  },
  {
    key: "GSC_SERVICE_ACCOUNT_JSON",
    label: "Google Search Console service account JSON",
    description:
      "JSON key for a Google service account with Search Console API access. Used by the (deferred) GSC integration to push canonical/indexation hints. Paste the full JSON file contents.",
    multiline: true,
    docs_url: "https://developers.google.com/webmaster-tools/v1/how-tos/authorizing",
  },
  {
    key: "OMEGA_INDEXER_KEY",
    label: "Omega Indexer API key",
    description:
      "Submits URLs to Omega Indexer for accelerated discovery (Google + others). Triggered alongside IndexNow on every config save. API integration pending — slot reserved.",
    docs_url: "https://omegaindexer.com/",
  },
  {
    key: "SINBYTE_API_KEY",
    label: "Sinbyte API key",
    description:
      "Submits URLs to Sinbyte's indexing service. Triggered alongside IndexNow on every config save. API integration pending — slot reserved.",
    docs_url: "https://sinbyte.com/",
  },
  {
    key: "PRIME_INDEXER_KEY",
    label: "Prime Indexer API key",
    description:
      "Submits URLs to Prime Indexer's bulk-submission service. Triggered alongside IndexNow on every config save. API integration pending — slot reserved.",
    docs_url: "https://www.theprimeindexer.com/",
  },
] as const;

/** Lookup by key. Returns undefined when the key isn't a known slot. */
export function getSlot(key: string): SecretSlot | undefined {
  return SECRET_SLOTS.find((s) => s.key === key);
}

/**
 * The set of valid slot keys. Used by the write path to reject any
 * attempt to set an unknown key (avoids accumulating dead rows).
 */
export const SECRET_SLOT_KEYS: ReadonlySet<string> = new Set(SECRET_SLOTS.map((s) => s.key));
