---
name: c18-00-foundation
overview: 'Prepare the isolated Promotion owner and generated contracts for C18 without activating downstream consumers or changing Pricing behavior.'
todos:
  - id: execution-preflight
    content: 'Re-read all 15 C18 issues and current labels, confirm approved execution, prepare a Locki sandbox from current main, and record the base and unrelated dirty files.'
    status: completed
  - id: generator-preflight
    content: 'Inspect the pinned generator help and current authorization contract; resolve missing generator coverage before creating supported business artifacts.'
    status: completed
  - id: generate-owner
    content: 'Generate the promotion MicroVertical, commerce.promotion module contract, Action boundary and Promotion/Voucher resource contracts; keep active production composition unchanged.'
    status: completed
  - id: freeze-lane-contracts
    content: 'Agree generated owner-local contract locations, exact purchase input, fact-loading ports, proof storage, mutation concurrency and test fixtures before parallel edits.'
    status: completed
  - id: review-foundation
    content: 'Review the generated diff against current repository guidance, run generation and contract checks, and release the stable interfaces to implementation lanes.'
    status: completed
isProject: false
---

# c18-00-foundation

## Execution Notes

This is an execution plan, authored 2026-11-06 on `plan/c18-promotion-1160`, based on committed `main@26f1caf9b41603c927b13542436cef8a3c47f406`. No implementation or application tests were run while planning. Read [the root rollup](c18-99-rollup.plan.md) for complete issue coverage and the exact graph command.

The application root is `app/`. Paths below are relative to that directory unless prefixed `../`. At planning time the checkout contains unrelated changes to `.gitignore`, untracked `CONTEXT.md` and `docs/ops/`. Preserve them and the existing stash. The untracked `app/CONTEXT.md` is restored local material, not canonical product guidance. Use `../docs/README.md`, `../CONTEXT-MAP.md`, the focused contexts and current issue bodies.

Observed implementation:

- No `verticals/promotion/` owner exists. The intended app identity is `promotion`; the existing Pricing fence already names module `commerce.promotion`.
- `packages/pricing-contracts/src/domain/promotion-contribution.ts` carries the older single-application/PRE_TAX seam. C18 #1171 is the successor business contract; do not mutate the old seam into C18 adoption.
- `packages/pricing-contracts/src/domain/exact-decimal.ts` defines bounded exact decimal arithmetic, allocation scale 18 and the publication profile. `rounding-boundary.ts` owns final NET line publication. Inspect public exports before reuse; do not import another deployment's business implementation.
- `verticals/pricing/src/integrations/promotion-module-not-installed-final-fence.ts` deliberately fails closed when Promotion is installed without downstream proof replay/generation support. Adding source/topology must not silently install Promotion into the active composition, relax this fence or activate #894.

Required reading before execution: `../AGENTS.md`, `AGENTS.md`, `README.md`, `DEVELOPMENT.md`; routed `docs/architecture/{MICROVERTICALS,ACTIONS,ERRORS,AUTHORIZATION,DATABASE,DATA_ACCESS,MODULE_MANIFESTS,MODULE_ENTRYPOINTS,VALUE_OBJECTS}.md`; database work also follows `DATABASE_TRUST_BOUNDARIES.md` and `DRIZZLE_V1_UPGRADE.md`. Read `../docs/contexts/promotion/GLOSSARY.md`, relevant Commerce/OntOS context sections and accepted ADR-0016, ADR-0017 and ADR-0030. Follow task-relevant mandatory references transitively. Read OUTBOX_WORKERS only if a justified Outbox producer is introduced. There is no requested UI.

Issue bodies and all comments for #1160 through #1174 were read; the GitHub sub-issue API confirmed three branches and eleven leaves, with no deeper descendants. All 15 were open, specified and `status:now` during planning. Recheck live state before implementation. #253 was read only as sequencing context.

## Constraints

Global constraints apply to every lane. Do not implement until the user explicitly starts execution. Planning is allowed before execution status assignment, but execution must honor each live status gate. Never change status labels without explicit HITL instruction. Closed issues are read-only. #253 is always READONLY: no edits, comments, labels, children or other mutations.

Scope is #1160 and its existing descendants only. Do not create downstream issues, plans, connectors or consumer implementations. Exclude Storefront/BFF, Cart, Checkout, Order/Commitment, TAX computation, Pricing adoption, Delivery pricing/carriers/shipments, Payment, Billing, rollout and legacy Promotion/Voucher migration. The presence of a downstream `status:now` label does not expand this task.

Keep every public write in generated typed Actions and every governed read under Core. Preserve Effect errors, independent deployment seams, owner-local transactions, trusted Tenant/legal-entity context, request authentication, permission gates, module state and durable evidence. Never read `.env`, bypass hooks, suppress TSGo/Ultracite/Oxlint, or hand-author initial supported business files. No speculative generic rules engine, business Promotion Revision, new ShippingTarget resource, quota/loyalty subsystem or GROSS conversion.

C18 may define owner-local input ports for externally issued facts and test them with owner-local doubles. Such ports are conditional requirements, not implemented Delivery/TAX/Commerce APIs and not authorization to invent their canonical identities. Missing required authority remains typed unavailable/unverifiable. Pure public arithmetic or schemas can be reused where their ownership permits; private logic, fixtures, repositories and registrations cannot cross owners.

## Operator Guidance

Coordinator owns generator invocations, topology, manifests, registration, package exports, workspace metadata, lockfile and shared test setup. Never run generators concurrently against shared files. Implementing subagents get explicit disjoint file lists after generation; adding another business artifact returns through the coordinator. Start from the pinned full-vertical generator, then module-contract, then supported artifacts. Prefer an API-only owner if the pinned generator supports it; otherwise use its supported output and approved retirement path for unused UI contributions. Do not fabricate generator flags.

From `app/`, inspect `mise exec -- pnpm exec modern-js-create --help`, then use the supported `mise exec -- pnpm exec modern-js-create promotion --vertical` flow. Inspect every relevant `scaffold:* -- --help` first. Generate module contract with `mise exec -- pnpm scaffold:module-contract -- --vertical promotion --module commerce.promotion`, then `scaffold:microvertical-action-boundary -- --vertical promotion`, and `scaffold:resource -- --vertical promotion --resource promotion` and `--resource voucher`. Generate each Action with `scaffold:action`, its necessary Action service with `scaffold:action-service`, its HTTP boundary with `scaffold:action-http`, and governed management reads with `scaffold:module-api`. All use `mise exec -- pnpm` and their supported scope/access flags. Do not add HTTP evaluation/proof adoption APIs under #1171. If a required category has no approved generator/gateway, extend and validate the boundary or obtain the required developer decision before that artifact; do not silently skip its issue.

Planning attempted `mise exec -- pnpm scaffold:module-contract -- --help`; mise refused the untrusted `app/.mise.toml` before running pnpm. Its tool declarations and scaffold CLI help source were inspected. Help execution and generator behavior remain execution preflight work. Inspect and trust the repository configuration in the execution sandbox, then install the repository-managed toolchain/dependencies as needed. Do not claim generator validation passed here.

Use the Locki workflow in DEVELOPMENT.md for implementation, with a feature branch based on current committed main. Carry these plan files into that sandbox without unrelated dirty files. Resolve public schema imports during foundation and build Promotion-owned fixtures from those schemas and accepted numerical examples; never import another deployment's private fixtures/tests; avoid inventing a parallel purchasing context. Prefer generated owner shared contracts first; add a dedicated schema-only contracts package only when required by the approved generator/export convention. No shared package may contain executable Promotion business logic.

Foundation checks after generation: `mise exec -- pnpm check:local --scope generation`, `mise exec -- pnpm contract:check`, `mise exec -- pnpm module-entrypoints:check`. A reviewer must inspect actual generated output, scope/access declarations and absence of active composition publication. All todos are pending until execution evidence exists.

## Implementation Evidence

- Execution preflight: all fifteen live issues remain open/specified/status:now. Locki sandbox f6l7qvev on codex/c18-promotion-1160#locki-f6l7qvev, based on main@26f1caf9b41603c927b13542436cef8a3c47f406.
- Sandbox preparation passed after installing missing openssl inside the container: frozen dependency install, local TLS/environment setup, Docker PostgreSQL/SpiceDB health, all current-main migrations, local initialization and complete application DB verification.
- Pinned full-vertical generator --help and API-only dry-run passed. Module-contract/resource/action-service/Action-boundary/action/action-http/module-api help inspected. No missing business category identified for the planned generated services/contracts.
- API-only owner, module contract, auth boundary, Promotion/Voucher resources, ten private services, thirteen protected Actions and four protected management Read APIs generated. Unrelated full-vertical sample CRUD and Shell rewrites pruned; no release-intent membership changed.
- `mise exec -- pnpm contract:check` passed. Generation suite: 188/190 passed, two subprocess timeout failures. Sequential reruns: finalizer fixture passed; malformed CLI multi-launch fixture still exceeded its existing 30-second scenario budget. No timeout/enforcement changes made.
- Independent foundation review found/fixed stale topology client paths, missing TS test inclusion and direct deploy bypass. Reviewer verified fixes. Module-entrypoints check remains running. Foundation review is not complete.
- Family and lifecycle focused tests initially passed 6/6 and 10/10; enforced native DateTime/branding/lint corrections are underway, so final lane acceptance remains pending.

## Final foundation validation, 2026-11-07

Independent source review found no remaining foundation defect. The complete frozen-source check passed, including both API validators, contract validation and module-entrypoint boundaries. Full tooling passed all 190 generation tests, 1,597 scripts tests and 125 deployment-impact tests. The native cache and original worktree retained identical source manifests throughout. Foundation review is complete; this does not close the separate required full application build or final acceptance/rollup tasks. See `.codex/reports/c18-final-validation-review.md`.
