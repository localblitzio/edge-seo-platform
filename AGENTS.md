# AGENTS.md

Entry point for OpenAI Codex and other coding agents.

Read [docs/tech-spec.md](docs/tech-spec.md) end-to-end before writing any code. Then read the module spec for the area you're working in (tech spec §6).

The longer orientation document is [CLAUDE.md](CLAUDE.md) — same rules apply to all agents.

Hard constraints (tech spec §1):

- TypeScript strict mode, no `any`.
- Stop and ask on any spec ambiguity.
- No new dependencies beyond §3.2 without approval.
- Don't refactor unrelated code while making changes.
- Every public function: JSDoc with `@param`, `@returns`, `@throws`.
- Every module: a corresponding test file.
- All commits pass typecheck, lint, and test.
