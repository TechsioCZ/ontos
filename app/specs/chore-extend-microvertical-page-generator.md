---
type: chore
status: done
created: 2026-08-13
---

# Chore: Extend the MicroVertical page generator

## Chore Description

Extend the existing Codesmith `scaffold:microvertical-page` command so a developer can generate a
named page for an existing MicroVertical at an explicit root-relative URL. The current generator
already accepts `--vertical` and `--page`, creates governed page and Shell wiring, and defaults to a
private, non-indexable route. It does not accept a URL independently of the page identifier, and its
starter renders a description and empty-state message in addition to the title.

Keep `--page` as the stable lower-kebab page name used for component, locale, entrypoint, and Module
Federation identities. Add `--url <root-relative-path>` as a supported customization. When it is
omitted, derive the canonical path as `/<microvertical>/<page>` from the discovered MicroVertical
slug and page name, so `--vertical crm --page customers` produces `/crm/customers`. The i18n router
adds the active locale at runtime, yielding `/cs/crm/customers` or `/en/crm/customers`; locale text
must never be embedded in the generator input or canonical manifest path. Use an explicit URL to
override the complete canonical path. Use the resulting URL to choose the nested TanStack route
directories and every canonical/localized/Shell contribution path while continuing to use the page
name for stable identifiers. The generated page's only visible content must be its localized title;
route-head metadata may retain a non-visible localized description.

The canonical user-facing route remains the Shell-owned connector. It must resolve the exact page
entrypoint through the existing authenticated Shell session, selected legal entity, module-state,
and module-permission gates before loading the private remote component. Anonymous or unresolved
context must not load or render the generated MicroVertical page. No page-specific authentication,
backend call, Action, BFF, React state, or shared component is added to the empty starter.

## Relevant Files

Use these files to accomplish the chore:

- `../AGENTS.md` — defines the mandatory generator invocation that the optional URL flag must remain backward-compatible with; do not modify this file because work is restricted to `app/`.
- `AGENTS.md` — authoritative architecture, gateway, generator, and toolchain rules.
- `README.md` — documents the existing MicroVertical page command and should show the explicit URL customization.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — requires Shell/Core to gate a page before resolving its private implementation.
- `docs/architecture/MODULE_MANIFESTS.md` — documents the page generator order and command contract.
- `docs/frontend/FRONTEND.md` — governs localized, accessible, responsive generated frontend output.
- `scripts/scaffolding/cli.mts` — owns page flags, required arguments, help text, and `PageScaffoldConfig` construction.
- `scripts/scaffolding/shared.mts` — owns the page scaffold configuration/result types and shared path-safety helpers.
- `scripts/scaffolding/microvertical-page/scaffold.mts` — renders the page and metadata, patches locales, manifest/registration/Module Federation/Shell wiring, detects conflicts and reruns, and refreshes both route owners.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable-workspace coverage for exact page output, CLI behavior, path containment, collisions, deterministic wiring, reruns, and no-partial-write behavior.
- `packages/core-runtime/src/modules/shell-contribution.ts` — authoritative root-relative Shell page route-path schema that generator URL validation must match.
- `apps/shell-super-app/shared/api.ts` — typed module-target request/response contract used before a private page component may load.
- `apps/shell-super-app/api/modules/shell-composition.ts` — currently resolves only a module's first navigation page and must support an exact requested page entrypoint.
- `apps/shell-super-app/api/modules/shell-governed-reads.ts` — governed read that must pass and validate the exact requested page while retaining module permission/evidence behavior.
- `apps/shell-super-app/api/index.ts` — authenticated Effect HTTP handler that forwards the typed exact-page request into the governed read.
- `apps/shell-super-app/src/api/auth-client.ts` — generated-contract client adapter consumed by the Shell route loader.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` — generic landing-page loader that must retain its current module-landing behavior when no exact page is supplied.
- `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx` — authenticated Shell layout, explicit loading/forbidden/not-found/unavailable states, and lazy approved-page resolution to preserve.
- `apps/shell-super-app/tests/unit/auth-contract.test.ts` — exact request-schema and safe public-contract coverage.
- `apps/shell-super-app/tests/unit/shell-composition.test.ts` — exact-page, module ownership, lifecycle, and permission decision coverage.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — live Effect endpoint coverage for anonymous rejection and authenticated exact-page resolution.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — authenticated generated CRM page behavior and visible starter-content expectations.
- `verticals/crm/src/routes/[lang]/crm/page.tsx` — existing exact generated page to migrate only by rerunning the updated generator.
- `verticals/crm/locales/en/crm.json` — generated English title and route-description copy for the migrated CRM starter.
- `verticals/crm/locales/cs/crm.json` — generated Czech title and route-description copy for the migrated CRM starter.

### New Files

- `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` — focused proof that generated exact-page loaders forward the requested page entrypoint and that anonymous/selection-required states never request or load a remote page.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define and test the backward-compatible CLI contract

- [x] Extend `PageScaffoldConfig` in `scripts/scaffolding/shared.mts` with an optional URL and update the `microvertical-page` definition in `scripts/scaffolding/cli.mts` to accept `--url <url>` and document it in `--help`. Keep `--page` and `--vertical` required so `mise exec -- pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page>` remains valid, but define its new omitted-URL result as `/<discovered-microvertical-slug>/<page>`.
- [x] Add CLI and disposable-fixture assertions in `scripts/scaffolding/tests/scaffold-generators.test.mts` proving that omitted `--url` with `--vertical inventory-stock --page purchase-orders` produces canonical `/inventory-stock/purchase-orders` and localized runtime URLs such as `/cs/inventory-stock/purchase-orders`. Also cover the explicit override `--page purchase-orders --url /purchasing/orders`, duplicate/empty/unknown URL flags, and write-free `--help`/validation failures.

### 2. Separate stable page identity from route URL in Codesmith

- [x] Add a single page-route parser in `scripts/scaffolding/microvertical-page/scaffold.mts` that accepts only the same root-relative, lowercase kebab-segment paths allowed by `ShellPageContributionSchema`: no origin, locale prefix, query, fragment, trailing slash, dot segment, empty segment, parameter/wildcard syntax, backslash, encoded traversal, or path beyond the schema's 200-character limit. Return normalized path segments for filesystem work and the canonical URL for metadata/contracts.
- [x] When `--url` is absent, compose the canonical URL only after authoritative vertical discovery as `/${vertical.slug}/${page}`; never derive it from the dotted OntOS `moduleId`, a localized route, display copy, or an unvalidated raw path. When `--url` is present, treat it as the complete canonical-path override. Use the resulting URL segments, not the page identifier alone, for the owning vertical and Shell route directories. Derive correct relative imports for any supported nesting depth, and use the exact canonical URL in vertical/Shell `canonicalPath`, every supported locale's `localisedPaths`, the manifest page contribution's `routePath`, and route collision checks. Continue deriving component names, translation keys, entrypoint/contribution/component keys, federation exposure names, and lazy client identities exclusively from `--page`.
- [x] Preflight all target directories, Shell routes, manifest/registration slots, federation exposes, client entries, and locale keys before applying any mutation. Reject a URL already owned by another page, a reused page identity at another URL, reserved/dynamic Shell route collisions, traversal, and partial legacy output without changing any file.
- [x] Change the rendered MicroVertical starter so `UltramodernRouteHead` is retained but the localized title is its only visible page content. Remove the visible description and empty-state message, retain only metadata copy that `route.meta.ts` actually consumes, and keep semantic heading structure, responsive token-based Tailwind styling, and zero BFF/state/effect code.
- [x] Update exact-output tests for the default two-segment MicroVertical/page URL and add explicit one- and multi-segment override tests proving generated route locations/imports, metadata, manifest contribution, Shell connector, Module Federation exposure, locale preservation, route refresh for both app owners, formatter stability, and absence of visible starter copy beyond the heading.

### 3. Resolve the exact generated page through the authenticated Shell gateway

- [x] Extend `ResolveModuleTargetPayload` and its Effect Schema in `apps/shell-super-app/shared/api.ts` with an optional stable page `entrypointKey`. Preserve the existing module-only request as the module landing-page contract; generated URL connectors must send their own exact entrypoint key.
- [x] Thread the optional entrypoint key through `apps/shell-super-app/api/index.ts`, `apps/shell-super-app/api/modules/shell-governed-reads.ts`, and `apps/shell-super-app/api/modules/shell-composition.ts`. When supplied, resolve only the page with that key from the requested module contract; reject missing or cross-module keys as not found. Then apply the same selected-context, module-state, module-permission, governed-read evidence, and typed `401`/`409`/`403`/`404`/`503` mappings before returning its component key. Do not resolve or import the private page on any unsuccessful outcome.
- [x] Generate each Shell connector loader with both its module ID and exact page entrypoint key while leaving `apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.ts` on the module-only landing behavior.
- [x] Update `apps/shell-super-app/tests/unit/auth-contract.test.ts` and `apps/shell-super-app/tests/unit/shell-composition.test.ts` beside the contract/runtime changes. Cover exact selection among at least two pages in one module, unknown and foreign page keys, module landing fallback, active/read-only/deprecated allow states, denied lifecycle states, definite permission denial, unavailable permission/state/catalog, and selected-legal-entity requirements.
- [x] Add `apps/shell-super-app/tests/unit/routes/modules/loader.test.ts` and extend `apps/shell-super-app/tests/integration/auth-runtime.test.ts` to prove generated connector forwarding, anonymous `401`, selection-required `409`, authenticated exact-page success, forbidden `403`, missing `404`, unavailable `503`, and that private lazy loaders are invoked only after a resolved authenticated response.

### 4. Preserve safe reruns and migrate the existing generated CRM starter

- [x] Teach the page generator to recognize only the exact previous generated page/locale/metadata/wiring shape as a safe migration candidate; developer-edited or partial output must still fail closed. Upgrade a recognized legacy page atomically to the title-only template while preserving its old URL only when the migration command supplies that URL explicitly. This lets the checked-in CRM page retain `/crm`, while newly generated omitted-URL pages use `/<microvertical>/<page>`.
- [x] After the updated generator and migration tests pass, run `mise exec -- pnpm scaffold:microvertical-page -- --vertical crm --page crm --url /crm` from `app/` to migrate the checked-in generated CRM page and refresh CRM and Shell route artifacts. Do not edit the generated business files or wiring by hand.
- [x] Update `apps/shell-super-app/tests/e2e/login.spec.ts` to assert that an authenticated English/Czech visit to the CRM URL renders its localized title with Shell chrome and no generated description/empty-state copy. Add an anonymous direct-URL assertion that no CRM title or remote content renders before authentication.

### 5. Document the supported generator behavior

- [x] Update `README.md` and `docs/architecture/MODULE_MANIFESTS.md` with the optional `--url <root-relative-path>` form, an explicit override example, the default `/<microvertical>/<page>` behavior, the router-owned locale prefix, the distinction between page identity and URL, title-only starter output, and the existing authenticated Shell/Core gateway requirement. Document the concrete example `--vertical crm --page customers` → canonical `/crm/customers` → Czech `/cs/crm/customers`. Do not describe `public: false`/`indexable: false` as authentication by themselves.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` in order and resolve all chore-related failures without unrelated source, dependency, lockfile, topology, or generated business-artifact changes. Unrelated baseline and local-environment limitations are recorded in Implementation Evidence.

## Testing Strategy

Use the existing Node test runner against temporary workspaces for the generator's CLI, URL parser,
path planning, exact output, atomic owner wiring, legacy migration, rerun, collision, traversal, and
no-partial-write behavior. Use focused Shell unit and integration tests for the typed exact-page
request and authenticated gateway. Retain the module-only landing route as a compatibility case.
Use the existing Playwright authenticated CRM flow for the generated title-only starter and one
anonymous direct-route assertion; no business loading, empty, validation, conflict, or retry UI is
generated because the starter performs no business operation. Shell loading, selection-required,
forbidden, not-found, and unavailable states remain explicit and are tested at their existing
integration boundary.

## Acceptance Criteria

- [x] The repository continues to provide one Codesmith command named `scaffold:microvertical-page`; no duplicate generator is introduced.
- [x] The command accepts required `--vertical` and `--page` arguments plus optional `--url`; omitting `--url` keeps the repository-mandated two-flag invocation valid and generates canonical `/<microvertical>/<page>`.
- [x] `--vertical crm --page customers` without `--url` generates canonical `/crm/customers`, which the localized router exposes as `/cs/crm/customers` and `/en/crm/customers`.
- [x] `--page` is the stable lower-kebab identity and `--url` is an independently validated root-relative path that may contain multiple lowercase kebab-case segments.
- [x] A custom URL controls both vertical and Shell route locations plus all canonical/localized/manifest paths without changing page, entrypoint, locale, or federation identities.
- [x] Generated page source has one localized visible title and no visible description, empty-state copy, data call, Action, BFF call, React state/effect, new shared component, or hardcoded user-facing string.
- [x] The generated route is private and non-indexable and its canonical Shell connector does not render or lazy-load the MicroVertical page for an anonymous or incompletely selected session.
- [x] An authenticated, selected, permitted user resolves the exact page requested by its generated URL even when the module exposes multiple pages; the generic module route still resolves its landing page.
- [x] Missing/cross-module page targets and module lifecycle, permission, or infrastructure failures preserve the existing declared typed Shell error/status contract and never load private code.
- [x] Nested URLs, collisions, traversal attempts, duplicate identities, partial output, and developer-edited existing pages fail before any mutation; exact legacy generated output upgrades atomically and future reruns are no-ops.
- [x] Existing CRM generated output is migrated only through the updated Codesmith command; generated-output tests prove title-only English/Czech copy and the browser assertion is checked in. Local browser execution was limited by the existing authorization dataset as recorded below.
- [x] Documentation accurately describes the command, compatibility default, URL constraints, generated output, and authenticated Shell ownership.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — typecheck the CLI, generator, helpers, and disposable-workspace tests.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — lint generator infrastructure not covered by the root application lint paths.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — run all Codesmith unit and disposable-workspace integration tests.
- `mise exec -- pnpm scaffold:microvertical-page -- --help` — verify command discovery and the documented optional URL without writing.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — run Shell contract, composition, loader, and component unit tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — run the authenticated Effect endpoint integration suite.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e -- --grep "CRM|authenticated"` — run focused authenticated/anonymous generated-page browser coverage.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` passed.
- Focused page-generator coverage now proves formatted multi-page owner slots, exact current/legacy
  wiring (including conflicting duplicates), one- and multi-segment URLs, two-letter owner slugs,
  exact page identities, general explicit locale-prefix rejection, and reserved, dynamic, and
  cross-owner collision preflight. It also executes a newly generated federated page with the
  owner's English and Czech resources. The full scaffolding suite passed 35/38; its three failures
  are unrelated existing baselines: a stale Action fixture missing
  `--legal-entity-scope`, unavailable generated gateway-issuer keys, and a disposable typecheck
  fixture missing `system-principal-context-provenance.ts`. The formatter-stability generator test
  passed.
- `mise exec -- pnpm scaffold:microvertical-page -- --help` passed and documented the optional URL
  plus `/<vertical>/<page>` default. A read-only real-workspace plan reports zero mutations for the
  migrated CRM page and twelve mutations for a new CRM `customers` page; `/modules/bad` is rejected
  against the existing `[moduleId]` route.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` passed 146/146 tests. Exact-page UI
  coverage proves that private registries and loaders remain untouched for selection-required,
  forbidden, not-found, and unavailable outcomes and run once only after resolution.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` was attempted. The suite parsed
  the added exact-page `401`/`409`/`200`/`403`/`404`/`503` assertions but the live auth tests stopped
  at the existing root configuration prerequisite (`AuthConfigError`/missing `DATABASE_URL`).
- The focused Playwright command was attempted and stopped at the existing root development
  environment prerequisite before browser execution. Checked-in coverage now asserts anonymous and
  authenticated English/Czech CRM behavior.
- `mise exec -- pnpm check` passed formatting, application lint, 58/58 Core Action tests,
  typechecking, and skills checks before stopping on the unchanged CRM `modern.runtime.ts` i18n
  boundary baseline.
- `mise exec -- pnpm build` completed the Shell production and TypeScript build, then stopped at the
  existing missing CRM Module Federation DTS archive prerequisite.

## Notes

- This is generator/tooling maintenance, so it is classified as a chore rather than a new product feature.
- `--page` is treated as the developer-facing page name/identity, not as already localized display copy. The starter retains the existing localized placeholder title (`New Page`/`Nová stránka`); product-specific titles are edited in every owning locale after generation.
- Authenticated-only means the canonical page is resolved and loaded through the existing Shell/Core session, legal-entity, module-state, and permission gateway. The MicroVertical starter does not implement a second authentication system. Deployment-level ingress policy for a remote's standalone origin is outside this chore.
- The URL is optional for backward compatibility with the exact mandatory command in `../AGENTS.md`. Its omission intentionally changes the default for newly generated pages from the current `/<page>` behavior to `/<microvertical>/<page>`; supply `--url` whenever a legacy or custom path must be retained.
- “MicroVertical URL” is interpreted as the discovered, validated MicroVertical slug under the locale-aware Shell router. The canonical generator value excludes the locale; `[lang]` adds `/cs`, `/en`, or another supported locale at runtime.
- No mandatory business generator is the first task because this chore changes generator/runtime infrastructure rather than initially creating a business page. The existing CRM business artifact is migrated later with the updated mandatory generator, never by hand.
