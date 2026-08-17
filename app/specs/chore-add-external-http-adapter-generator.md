---
type: chore
status: done
created: 2026-08-17
---

# Chore: Add a MicroVertical external HTTP adapter generator

## Chore Description

Add a reusable Codesmith command for creating the required starting point for one private,
server-side external HTTP adapter owned by an existing OntOS MicroVertical. The command must encode
the repository's Effect-first dependency seam, safe owner-local placement, generated-file marker,
and mutation guarantees without inventing provider-specific schemas, authentication, status
classification, retry, timeout, cache, coalescing, concurrency, or business mapping rules.

The first concrete consumer is the CRM ARES subject adapter in
`specs/feature-crm-ares-adapter.md`. This chore creates and validates only the generator; the ARES
feature will invoke it and adapt its generated output in a separate implementation task.

## Relevant Files

Use these files to accomplish the chore:

- `package.json` — exposes every supported Codesmith command through a repository-managed pnpm
  script.
- `scripts/scaffolding/cli.mts` — owns the typed command union, help, flags, validation, generator
  dispatch, and result/config unions.
- `scripts/scaffolding/shared.mts` — owns generator headers, typed configs/results, canonical slug
  validation, OntOS MicroVertical discovery, contained-path resolution, formatting, overwrite
  refusal, and mutation-plan application.
- `scripts/scaffolding/generator-adapter.mts` — adapts a mutation planner to Codesmith execution.
- `scripts/scaffolding/action-service/scaffold.mts` — nearest small owner-local Effect service
  generator and its create-only mutation pattern.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable-workspace tests for command
  help, exact output, invalid input, traversal, overwrite, atomicity, formatting, composition, and
  generated-source compilation.
- `scripts/scaffolding/tsconfig.json` — strict typecheck surface for generator implementation.
- `AGENTS.md` — authoritative in-application Codesmith rules and the command developers must run
  before adding a private external HTTP adapter.
- `docs/architecture/ULTRAMODERN.md` — Effect-first I/O, generated starting-point, and private
  implementation rules.
- `docs/architecture/MICROVERTICALS.md` — strict ownership and deployment seams that keep an adapter
  inside its owning MicroVertical.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — distinguishes private implementations from governed
  public module entrypoints and forbids accidental public registration or exports.
- `docs/architecture/ERRORS.md` — requires provider failures to remain tagged and typed until a
  later public endpoint maps them to its declared contract.
- `specs/feature-crm-ares-adapter.md` — first consumer and proof that the generated shape has a
  concrete reuse case.

### New Files

- `scripts/scaffolding/external-http-adapter/scaffold.mts` — Codesmith mutation planner and
  compile-safe template for one private MicroVertical-owned external HTTP adapter.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Lock the command contract with generator tests

- [x] Extend `scripts/scaffolding/tests/scaffold-generators.test.mts` before implementation with the
      command `external-http-adapter` and the required flags `--vertical`, `--provider`, and
      `--operation`. Prove that `--vertical crm --provider ares --operation subject` targets exactly
      `verticals/crm/src/integrations/ares/ares-subject.service.ts`, uses deterministic provider- and
      operation-derived symbols, and changes no manifest, runtime registration, package export, Module
      Federation exposure, locale, or Shell file.
- [x] In the same disposable fixtures, cover write-free `--help`, missing/unknown/duplicate flags,
      invalid or reserved provider and operation slugs, traversal attempts, a missing or malformed
      generated OntOS MicroVertical, an existing target file, and a planner failure. Assert that every
      rejected run leaves the complete fixture tree unchanged.
- [x] Add generated-output assertions proving the source has a versioned Codesmith marker, uses
      Effect and the Effect `HttpClient` context seam, is formatted deterministically, compiles against
      the repository's pinned Effect cohort, and composes with the existing generator suite without
      weakening its overwrite or path-containment guarantees.

### 2. Implement the external HTTP adapter mutation planner

- [x] Add typed external-adapter config/result declarations and a versioned generator header to
      `scripts/scaffolding/shared.mts`. Validate `provider` and `operation` independently with the
      existing canonical lower-kebab slug rule, and reuse `discoverOntosModule`,
      `resolveContainedPath`, and `createMutation` rather than adding parallel discovery, validation,
      formatting, or filesystem behavior.
- [x] Implement `scripts/scaffolding/external-http-adapter/scaffold.mts` with
      `createCodesmithGenerator`. Generate exactly one create-only source file at
      `verticals/<vertical>/src/integrations/<provider>/<provider>-<operation>.service.ts`; refuse to
      overwrite any existing file and return its absolute path in the typed result.
- [x] Render a compile-safe, fail-closed Effect starting point with deterministic Pascal/camel-case
      names derived from provider plus operation, an owner-local module interface, an injected Effect
      `HttpClient` seam captured by its construction/live layer, and a tagged typed placeholder failure
      that must be replaced when business behavior is implemented. Do not expose a raw HTTP client to
      callers, execute a request, use global/ad hoc `fetch`, add a browser import, or publish the
      implementation.
- [x] Keep provider policy out of the template: do not generate URLs, credentials, headers,
      request/response schemas beyond the minimal fail-closed scaffold, status mappings,
      retry/backoff, timeout values, cache/coalescing, concurrency limits, logging fields, or domain
      mapping. Those belong to each generated adapter's implementation and tests.

### 3. Wire the supported Codesmith command

- [x] Update `scripts/scaffolding/cli.mts` to import and dispatch the new generator, extend its
      command/config/result unions, accept only `provider`, `operation`, and `vertical`, and provide
      complete write-free help with the exact usage and an ARES example.
- [x] Add `scaffold:external-http-adapter` to `package.json`, invoking the existing scaffolding CLI
      in the same way as other commands. Do not add dependencies or a second command runner.

### 4. Document ownership and mandatory use

- [x] Update `AGENTS.md` and `docs/architecture/ULTRAMODERN.md` so a private third-party HTTP adapter
      inside any `verticals/*` package must start with the documented
      `scaffold:external-http-adapter` command using `--vertical`, `--provider`, and `--operation`.
      State that the output remains owner-local and must not patch or appear in a module manifest,
      runtime registration, package export, Module Federation exposure, generated BFF client, or Shell
      surface.
- [x] Document that the generated Effect `HttpClient` seam is the substitution point for
      deterministic tests, while every provider-specific input/result schema, tagged error union,
      request construction, resilience policy, diagnostics, and business mapping remains the owning
      adapter's responsibility.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` in order and resolve only failures introduced
      by this generator chore.

## Testing Strategy

Extend the existing disposable Codesmith fixture suite rather than creating a parallel runner.
Tests must exercise the public CLI interface and the resulting filesystem tree, including exact
generated output, format and compilation stability, OntOS MicroVertical ownership validation,
write-free failures, overwrite protection, path containment, and composition with the other
commands. The generator does not create a business test file: each consumer must author tests for
its real provider contract and failure paths after adapting the generated production starting
point.

## Acceptance Criteria

- [x] Running the documented command for `crm`, `ares`, and `subject` creates only
      `verticals/crm/src/integrations/ares/ares-subject.service.ts`.
- [x] Generated output is a private, compile-safe, fail-closed Effect module whose external HTTP
      dependency is substituted through Effect `HttpClient` and is not exposed through its caller
      interface.
- [x] The generator validates an existing generated OntOS MicroVertical, canonical provider and
      operation names, workspace containment, and no-overwrite behavior before applying mutations.
- [x] No generated or generator-side behavior publishes the adapter, registers a module
      entrypoint, crosses a MicroVertical seam, or supplies provider-specific runtime policy.
- [x] Help, failure, atomicity, formatting, compilation, and composition behavior are covered by
      deterministic generator tests.
- [x] The documented generator is a valid mandatory starting point for the private CRM ARES
      adapter, removing the current no-generator blocker from `specs/feature-crm-ares-adapter.md`.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — validate the
  new command's output, safety failures, formatting, compilation, and composition with existing
  generators.
- `mise exec -- pnpm typecheck` — validate generator, CLI, shared types, and generated fixture
  contracts against the repository TypeScript and Effect cohort.
- `mise exec -- pnpm lint` — validate source and architecture lint rules.
- `mise exec -- pnpm format:check` — validate deterministic repository formatting.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- This chore is the prerequisite for `specs/feature-crm-ares-adapter.md`; implement and integrate
  the generator before resuming that feature.
- The chore must not invoke the new generator against CRM or implement ARES. The ARES task will run
  it as its first implementation step and then adapt the output.
- `external-http-adapter` is intentionally transport-specific. Do not add generic SDK, database,
  queue, authentication, or provider-profile flags without a second concrete use case.
- The existing Effect `HttpClient` context is the true-external test seam. Do not add a second
  repository-wide port or shared external-integration framework for this single concrete need.
- Tests may be authored directly because they are verification artifacts; the mandatory generator
  governs the initial production business file.
- No unresolved developer decision blocks implementation.

## Implementation Evidence

### Summary

- Added the supported `scaffold:external-http-adapter` Codesmith command and create-only planner.
- Generated adapters are private, fail closed with a tagged typed error, capture the Effect
  `HttpClient` context seam in their live layer, and contain no provider runtime policy.
- Documented the command as the mandatory starting point for owner-local third-party HTTP adapters.

### Changed Files

8 files changed, 631 insertions(+), 2 deletions(-) (including two new untracked files).

### Tests Written or Updated

- `scripts/scaffolding/tests/scaffold-generators.test.mts` — proves exact CRM/ARES output and the
  single-file mutation boundary; write-free help and rejected runs; missing, unknown, duplicate,
  invalid, reserved, traversal, missing-owner, malformed-owner, overwrite, and planner failures;
  formatter stability; generated-source compilation; and deterministic generator composition.

### Validation

- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — passed, 40/40
  tests.
- `mise exec -- pnpm typecheck` — passed.
- `mise exec -- pnpm lint` — passed.
- `mise exec -- pnpm format:check` — passed.
- `mise exec -- pnpm check` — passed, including format, lint, Action unit tests, typecheck, skills,
  i18n, API, database-access, module-entrypoint, module-contract, workspace-contract, and
  performance-readiness gates.
- `mise exec -- pnpm build` — not run; the plan does not require a build and the change affects only
  scaffolding infrastructure, tests, command metadata, and documentation rather than runtime or
  bundled application output.
- Runtime/browser validation — not run; this chore has no user-visible runtime behavior.

### Review

- Re-read and reviewed against `../AGENTS.md`, `AGENTS.md`, `docs/architecture/MICROVERTICALS.md`,
  `docs/architecture/ACTIONS.md`, `docs/architecture/ERRORS.md`,
  `docs/architecture/ULTRAMODERN.md`, `docs/architecture/MODULE_ENTRYPOINTS.md`,
  `docs/architecture/MODULE_MANIFESTS.md`, the first-consumer ARES specification and integration
  context, and relevant repository architecture context.
- Inspected status, whitespace errors, stats, all task-relevant tracked changes, both new files, and
  the final generated output. The review found and fixed one documentation placement issue and
  added a distinct atomic planner-failure case. The affected suite and final quality gate passed
  afterward.
- No UI work or screenshots were applicable.

### Deviations and Follow-ups

- None.
