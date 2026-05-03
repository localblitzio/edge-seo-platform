/**
 * Log shipping integration. Logpush picks up `console.log` JSON lines and
 * delivers them to LOGS_R2 / external warehouse.
 * Spec: docs/tech-spec.md §7.11 (PRD) and §6.7.
 *
 * STATUS: configured at deploy time (Cloudflare dashboard / API), no runtime
 * shipping code required in the Worker. This module exists as a placeholder
 * for any future in-Worker batching/forwarding.
 */

export {};
