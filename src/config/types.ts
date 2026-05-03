/**
 * Re-exports of types inferred from `schema.ts` so consumers can avoid
 * importing zod transitively. The Zod schema in `schema.ts` is the source
 * of truth — do not redefine types here.
 */

export type {
  Authorization,
  CacheRule,
  CanonicalRule,
  CanonicalStrategy,
  ClientConfig,
  ConditionalRedirect,
  ContentInjectRule,
  ElementRemoveRule,
  FormHandling,
  IndexationRule,
  LinkRewriteRule,
  MetaRewriteRule,
  OriginAuth,
  PatternRedirect,
  RouteRule,
  SchemaInjection,
  StaticRedirect,
} from "./schema.js";
