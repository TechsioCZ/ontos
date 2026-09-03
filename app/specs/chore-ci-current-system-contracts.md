---
type: chore
status: done
created: 2026-09-02
---

# Chore: Make CI reflect the current system contracts

## Chore Description

Implement [GitHub issue #170](https://github.com/TechsioCZ/ontos/issues/170) by replacing the stale,
hand-maintained deployment-impact logic in the repository workflow with a fail-closed plan derived
from the current topology and ownership metadata, and by expanding required CI evidence to cover the
important test and runtime surfaces that are presently omitted.

The issue was written while the business MicroVertical was named Projects. Canonical `origin/main`
now contains the later Contacts rename, so implementation must use the current `shell-super-app` and
`contacts` identities. The deployment planner must derive application identities and owner paths
from `topology/reference-topology.json` and `topology/ownership.json` rather than embedding either
Projects or Contacts as the next hand-maintained workflow special case.

A green workflow must separately identify failures in static checks, generated contracts,
Codesmith generators, ordinary unit tests, service-backed integration tests, Node artifacts, and
Cloudflare/workerd artifacts. PostgreSQL and SpiceDB evidence must run against fresh CI-owned
services initialized from the tracked repository contracts, never against a developer machine or a
persisted shared database.

## Relevant Files

Use these files to accomplish the chore:

- `../.github/workflows/ultramodern-workspace-gates.yml` — GitHub's repository-root workflow,
  required check matrix, isolated service setup, deployment-impact planning, and ordered stage
  deployment.
- `package.json` — root command surface for unit, integration, repository-script, generator,
  deployment-planner, Node, and Cloudflare evidence.
- `packages/core-runtime/package.json` — missing complete Core unit and integration command surfaces
  needed by root CI commands.
- `docker-compose.yml` — tracked PostgreSQL 17 and SpiceDB 1.56 service definitions and health
  checks to reuse for isolated service-backed CI jobs.
- `topology/reference-topology.json` — authoritative Shell, MicroVertical, delivery-unit, dependency,
  runtime, and readiness identities consumed by the deployment planner.
- `topology/ownership.json` — authoritative owner paths used to map changed files to delivery units
  and reject unknown application owners.
- `topology/local-overlays/development.json` — generated local runtime identities that the workspace
  contract already reconciles with the reference topology.
- `zerops.yaml` — current `migrator`, `spicedb`, `contacts`, and `shellsuperapp` stage setup names and
  ordered deployment targets that must agree with topology and CI.
- `scripts/validate-ultramodern-workspace.mts` — existing exact topology, ownership, generated
  metadata, Zerops, toolchain, and workflow contract validator; extend its CI assertions rather than
  creating a second validator.
- `scripts/scaffolding/tests/module-contract-generator.test.mts` — existing module-contract generator
  regression suite currently outside required CI.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — existing Codesmith generator regression
  suite currently outside required CI.
- `scripts/tests/*.test.mts` — existing repository tooling, boundary, local initialization, Locki,
  Contacts authorization migration, and module-entrypoint regression suites currently outside the
  workflow matrix.
- `packages/core-runtime/tests/integration/*.test.ts` — live PostgreSQL, RLS, SpiceDB authorization,
  Action, identity, Outbox, tenant-isolation, module-state, and migration evidence.
- `apps/shell-super-app/tests/integration/*.test.ts` — Shell/Auth and generated-owner isolation
  evidence across Core, PostgreSQL, SpiceDB, and generated BFF seams.
- `verticals/contacts/tests/integration/*.test.ts` — owner-local Contacts database, governed
  operation, and BFF evidence.
- `scripts/proof-node-backend-federation.mts` — existing Node backend-federation artifact proof.
- `scripts/proof-workerd-ssr.mts` and `scripts/verify-cloudflare-output.mts` — existing
  Cloudflare/workerd runtime and generated-output proofs.

### New Files

- `scripts/plan-deployment-impact.mts` — topology- and ownership-driven changed-path planner with a
  CLI suitable for GitHub output and a deterministic JSON summary.
- `scripts/tests/plan-deployment-impact.test.mts` — focused regression coverage for change mapping,
  rename safety, dependency expansion, unknown-owner rejection, and safe full-deploy fallbacks.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Add a fail-closed deployment-impact planner

- [x] Create `scripts/plan-deployment-impact.mts` as an infrastructure tool that reads the reference
      topology and ownership files, accepts a base/head revision for production use and injectable
      changed paths for tests, and emits a deterministic ordered plan plus GitHub outputs.
- [x] Derive Shell and MicroVertical IDs, package paths, Shell dependency edges, and owner paths from
      tracked metadata. Keep only the fixed infrastructure phases (`migrator` and `spicedb`) as
      infrastructure concepts; do not encode `crm`, `projects`, or `contacts` as a workflow registry.
- [x] Implement the change-impact rules from `docs/architecture/DEPLOYMENT.md`: owner-local changes
      affect their delivery unit; migration/schema/config/verifier changes include the migrator; shared
      runtime or public-contract changes expand to consumers; SpiceDB schema/bootstrap/runtime changes
      include SpiceDB and its consumers; Shell changes include Shell; and common lockfile, workspace,
      runtime-materializer, Node-installer, deployment-manifest, topology, or ownership changes expand
      conservatively.
- [x] Fail with a targeted message when a changed path below `apps/*`, `verticals/*`, or `packages/*`
      cannot be mapped to an authoritative owner, when topology and ownership identities disagree, or
      when a topology delivery unit has no supported stage setup. Treat an all-zero, unavailable, or
      non-ancestor base revision as a safe full deployment rather than a false no-op.
- [x] Add `scripts/tests/plan-deployment-impact.test.mts` beside this behavior. Cover Shell-only,
      current Contacts-only, owner migration, shared-package, SpiceDB, lockfile/toolchain, topology,
      docs-only, deletion/rename, unknown new vertical, missing ownership, and invalid base cases. Prove
      that changing a topology ID in a fixture updates the plan without editing planner source.

### 2. Expose complete, composable test commands

- [x] Add complete `test:unit` and `test:integration` scripts to
      `packages/core-runtime/package.json` using the existing Node test layouts; keep the focused Action
      and Outbox commands for area-specific local use.
- [x] Add root scripts in `package.json` for all workspace unit tests, all service-backed integration
      tests, repository tooling tests, Codesmith/generation tests, and the deployment-impact planner
      tests. Use recursive `--if-present` package execution where it accurately follows existing
      package scripts, and keep generator and repository-script suites separate so their failures are
      identifiable.
- [x] Keep `action:test:unit`, add the existing Core Action integration surface to the root command
      set, and retain `outbox:test`. Do not make the local aggregate `check` run service-backed tests;
      the workflow jobs own fresh-service lifecycle and the README already requires generated CI to run
      separate gates.
- [x] Update the validation contract in `scripts/validate-ultramodern-workspace.mts` to require these
      root/package command surfaces, preventing a later package rename or script removal from silently
      reducing required evidence.

### 3. Make the workspace contract validate CI and deployment agreement

- [x] Extend `scripts/validate-ultramodern-workspace.mts` to assert that the repository workflow uses
      the pinned Node/pnpm toolchain, invokes the deployment planner, contains every required command
      category, starts isolated service-backed evidence, and gates stage deployment on all required
      jobs.
- [x] Reuse the validator's existing exact checks for reference topology, ownership, local overlay,
      generated contract, package scripts, and `zerops.yaml`. Add focused cross-checks that every
      topology delivery unit maps to the expected current Zerops setup/service-variable convention and
      that workflow source contains no stale `crm` or `projects` deployment branch.
- [x] Require clear stable workflow job/step names for format, lint, typecheck, contracts, unit,
      Action, repository tooling, generation, database/migration/RLS, authorization/Outbox, Node, and
      Cloudflare evidence. Assertion failures must name the missing or disagreeing area.

### 4. Expand the fast required CI matrix

- [x] Update `../.github/workflows/ultramodern-workspace-gates.yml` so independent fast checks run in
      parallel with descriptive names: formatting, lint, typecheck, skills, i18n/API/database-access/
      module-entrypoint/module-contract/workspace contracts, complete unit tests, Action unit tests,
      repository tooling tests, and Codesmith/generation tests.
- [x] Run every application command from `app/` through `mise exec -- pnpm`, retain the frozen
      install, pinned Node and pnpm versions, read-only checkout credentials, runner hardening, bounded
      timeouts, and `fail-fast: false` where a matrix is retained.
- [x] Keep each failure attributable to one command category; do not replace the matrix with the
      local aggregate `pnpm check` or hide several unrelated checks in one opaque step.

### 5. Add isolated PostgreSQL and SpiceDB evidence

- [x] Add one or more required Linux jobs that start the tracked `docker-compose.yml` services only
      after checkout, with explicit CI-only admin/runtime database URLs and SpiceDB settings matching
      `.env.example`, wait for both health checks, and always tear down containers and volumes.
- [x] On a fresh PostgreSQL volume, run `db:migrate` followed by `db:verify` before tests. This must
      prove the Core, Auth, and Contacts migration journals, exact schemas, and runtime-role grants; do
      not use `db:generate` as a substitute for applying and verifying migrations.
- [x] Run the complete workspace integration surface against those services so Core tenant/RLS,
      Action, authorization, identity, Outbox, module-state, migration, Shell/Auth, generated-owner,
      Contacts database, governed operation, and BFF tests are required evidence rather than tests that
      depend on a developer's local containers.
- [x] Use descriptive setup and test step names, preserve test-runner failure output, and print only
      bounded container diagnostics on failure. Never print credentials or read a local `.env` file.

### 6. Require both supported runtime proofs

- [x] Add a required Node runtime job that performs the repository build and then runs `node:proof`,
      with the source revision and public-site inputs already used by generated builds. Keep the Node
      proof distinct from source-level contract and type checks.
- [x] Add a required Cloudflare runtime job that runs `cloudflare:build`. This command must continue
      to build every topology app, verify generated Cloudflare output, and execute the Miniflare/workerd
      SSR proof; no real Cloudflare deployment or public URL is required in pull-request CI.
- [x] Give both runtime jobs separate bounded timeouts and artifact-specific failure names so a Node
      backend-federation failure cannot be confused with a Cloudflare/workerd failure.

### 7. Drive stage deployment from the reviewed impact plan

- [x] Replace the workflow's hand-written changed-path `case` block with
      `plan-deployment-impact.mts`, record its ordered JSON in the GitHub step summary, and expose only
      the booleans/data needed by later steps. A docs-only change may produce a reviewed no-op; an
      unknown application path must stop deployment planning.
- [x] Resolve stage service IDs through the planner's current unit identities and the existing
      environment-variable convention without logging the values. Preserve the required order:
      verified migrations, SpiceDB when affected, every affected provider MicroVertical, then Shell.
- [x] Generalize failure-log collection to report the failed planned unit with bounded output, and
      keep the migrator stop step unconditional after any attempted migration run.
- [x] Make stage deployment depend on every fast, service-backed, Node, and Cloudflare required job,
      so no partial green matrix can promote a revision.

### 8. Run the complete validation sequence

- [x] Execute every command in `Validation Commands` from `app/`, inspect the final diff for stale
      CRM/Projects workflow assumptions and accidental generated output, and confirm that only issue
      #170 infrastructure, test-command, and validation files changed.

## Testing Strategy

Add deterministic Node tests for the deployment planner and run every existing test family through
explicit root scripts. Planner fixtures must prove ordinary mapping, dependency expansion, current
identity derivation, fail-closed topology/ownership disagreement, and full-deploy fallback behavior.
The workspace contract validator supplies regression coverage for required workflow commands,
service-backed jobs, toolchain pins, stage dependencies, Zerops setup agreement, and stale names.

CI integration coverage must create fresh PostgreSQL and SpiceDB services, apply and verify all
migrations, and then run the existing cross-boundary suites. Node and Cloudflare jobs must execute
the generated runtime artifact proofs rather than stopping after compilation.

Important failure cases include:

- a new or renamed application directory absent from topology or ownership;
- a topology app missing its owner, Zerops setup, or Shell dependency relationship;
- a zero, missing, or rewritten deployment base revision;
- docs-only changes versus shared lockfile/toolchain changes;
- PostgreSQL or SpiceDB failing health checks or migration verification;
- stale generated topology, route, ownership, module-contract, Node, or Cloudflare artifacts;
- any required command or stage dependency being removed from the workflow.

## Acceptance Criteria

- [x] Deployment impact uses the current `shell-super-app` and `contacts` topology without a
      hard-coded CRM, Projects, or Contacts changed-path registry.
- [x] A changed application path that cannot be mapped through topology and ownership fails CI with
      the exact unknown path and area; invalid comparison bases conservatively request a full deploy.
- [x] Required CI jobs clearly cover format, lint, typecheck, skills, boundaries/contracts, complete
      unit tests, Action tests, repository scripts, Codesmith/generation tests, Node proof, and
      Cloudflare/workerd proof.
- [x] Fresh isolated PostgreSQL and SpiceDB services back required integration jobs, and their
      lifecycle neither reads a developer `.env` nor reuses persisted data.
- [x] The required evidence applies and verifies Core, Auth, and Contacts migrations and exercises
      database constraints, tenant/legal-entity RLS, authorization, Actions, identity, Outbox,
      module-state, generated-owner isolation, and Contacts governed operations.
- [x] `contract:check` fails with a targeted message when workflow commands, deployment setup,
      topology, ownership, local overlay, package scripts, or generated contracts disagree.
- [x] Stage deployment consumes the reviewed ordered impact plan and cannot run unless every fast,
      service-backed, Node, and Cloudflare required job succeeds.
- [x] Job and step names identify the failed area, while failure diagnostics remain bounded and do
      not expose credentials.
- [x] Existing application behavior, public contracts, MicroVertical boundaries, and generated
      business files are unchanged.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm test:deployment-impact` — Verify topology-driven impact mapping, dependency
  expansion, rename safety, and fail-closed behavior.
- `mise exec -- pnpm test:scripts` — Run repository tooling and boundary regression suites.
- `mise exec -- pnpm test:generation` — Run the Codesmith and module-contract generator suites.
- `mise exec -- pnpm test:unit` — Run complete unit/component coverage across packages, Shell, and
  Contacts.
- `mise exec -- pnpm contract:check` — Reconcile workflow, toolchain, topology, ownership, generated
  metadata, package scripts, and Zerops deployment contracts.
- `mise exec -- pnpm db:migrate && mise exec -- pnpm db:verify && mise exec -- pnpm test:integration`
  — Against fresh tracked PostgreSQL and SpiceDB services, apply and verify migrations and run the
  complete service-backed integration evidence.
- `mise exec -- pnpm build && mise exec -- pnpm node:proof` — Build and prove the Node deployment and
  backend-federation artifact shape.
- `mise exec -- pnpm cloudflare:build` — Build, verify, and execute the Cloudflare/workerd artifact
  shape locally.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Issue #170's Projects wording is historical. The Projects rename merged on 2026-08-28; canonical
  `origin/main` subsequently renamed that MicroVertical to Contacts on 2026-09-01. This plan follows
  the issue's intent—CI must describe the current system—by deriving names from topology and using
  Contacts only as the current fixture/evidence identity.
- The checkout used to write this plan was two commits behind `origin/main` and already contained
  unrelated changes to `docs/contexts/ontos/CONTEXT.md` plus an untracked Contacts-rename spec.
  Implementation must start from current `main` and must not absorb or overwrite those unrelated
  changes.
- GitHub branch-protection settings are outside the tracked repository surfaces inspected for this
  plan. The workflow will expose stable, descriptive required job names; selecting those names as
  protected required checks remains repository administration if it is not already configured.
- Browser E2E and live stage smoke expansion are not added by this bounded CI-reliability chore.
  Existing Node, workerd, database, authorization, contract, and integration proofs satisfy issue
  #170; the broader authenticated post-deploy smoke suite remains governed by
  `docs/architecture/DEPLOYMENT.md`.

## Implementation Evidence

### Summary

- Added a deterministic, fail-closed deployment-impact planner derived from reference topology,
  ownership, and current Zerops setups, with ordered migrator, SpiceDB, provider, and Shell phases.
- Expanded the required GitHub workflow into attributable fast, isolated service-integration, Node
  artifact, Cloudflare/workerd artifact, and reviewed stage-deployment gates.
- Added complete root and Core test command surfaces and exact workspace-contract assertions so
  removing a required command, job, setup, dependency, or current identity fails validation.

### Changed Files

- CI and planning: `../.github/workflows/ultramodern-workspace-gates.yml`,
  `scripts/plan-deployment-impact.mts`, and `scripts/tests/plan-deployment-impact.test.mts`.
- Command and contract surfaces: `package.json`, `packages/core-runtime/package.json`,
  `scripts/validate-ultramodern-workspace.mts`, and `scripts/check-ultramodern-api-boundaries.mts`.
- Runtime-proof compatibility: Shell and Contacts `modern.config.ts`, `scripts/proof-workerd-ssr.mts`,
  the worker-only Shell remote stub, Modern app-tools/BFF patches, `pnpm-workspace.yaml`, and
  `pnpm-lock.yaml`.
- Generator repair: `scripts/generate-ontos-module-contract.mts` now uses the current Effect endpoint
  identifier field when deriving operation keys.

### Tests and Validation

- `mise exec -- pnpm test:deployment-impact` — passed 22 tests.
- `mise exec -- pnpm test:scripts` — passed 37 tests.
- `mise exec -- pnpm test:generation` — passed 47 tests.
- `mise exec -- pnpm test:unit` — passed the complete Core, shared-package, Shell, Contacts unit, and
  component surfaces.
- `mise exec -- pnpm contract:check` — passed exact workflow, toolchain, topology, ownership,
  generated-metadata, package-script, and Zerops reconciliation.
- Fresh tracked PostgreSQL and SpiceDB services with CI-only environment values:
  `mise exec -- pnpm db:migrate && mise exec -- pnpm db:verify && mise exec -- pnpm test:integration`
  — passed migration, schema/grant, Core, Auth, Shell, Contacts, RLS, Action, authorization, identity,
  Outbox, module-state, and governed-operation evidence.
- `mise exec -- pnpm build && mise exec -- pnpm node:proof` — passed Node build and backend-federation
  artifact proof.
- `mise exec -- pnpm cloudflare:build` — passed all topology app builds, output verification, native
  Shell and Contacts workerd SSR, and direct/service-bound Contacts readiness evidence.
- `mise exec -- pnpm check` — passed the final repository quality gate.

### Review

- Final status and diff review found no tracked build output, generated business-file changes,
  stale CRM/Projects workflow branches, credential logging, unrelated application behavior changes,
  or public-contract expansion.
- The mandated Cloudflare gate exposed latent current-stack incompatibilities: Node builtin
  external interop, Effect-BFF worker-source propagation, loader retention, Effect finalizer setup,
  and verifier knowledge of supported workerd imports. The narrow config and dependency patches are
  required to make the existing runtime proof execute real worker artifacts rather than browser
  proxies or stubs.
- The same gate exposed two existing validation defects: the module-contract generator read the
  obsolete endpoint name field, and the API-boundary scanner included generated Cloudflare output
  and orphan package-link directories. Both were repaired and covered by the existing generation,
  contract, and final quality gates.
- No blocker remains. No browser E2E or live stage deployment was performed, as explicitly excluded
  by this specification.
