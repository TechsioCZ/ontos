---
type: feature
status: planned
created: 2026-07-30
---

# Feature: Better Auth Shell/Core tenant login

## Feature Description

Add email-and-password authentication to OntOS with Better Auth as a Shell/Core
capability. Authentication must not be implemented as a MicroVertical, deployment
vertical, or package under `verticals/`.

The Shell owns the login and home routes, Better Auth credential/session runtime,
session cookies, the strict Effect authentication BFF, and the private Drizzle schema
and migration history for Better Auth tables. Core continues to own tenants,
principals, `principal_auth_bindings`, and the resolver that maps an authenticated
Better Auth subject to exactly one active OntOS principal in one active tenant.

The localized home route has exactly two visible states:

- an anonymous visitor sees only a link to the login page;
- an authenticated user sees only safe information about the logged-in identity and a
  logout button.

Clicking logout must invalidate the Better Auth session, clear the browser session
cookie, and return the home route to its anonymous state.

## User Story

As an OntOS user
I want to sign in, see which identity is active, and log out
So that I can securely enter and leave the tenant context represented by my principal

## Problem Statement

The Shell currently has a UI-only login form and a promotional home page. It has no
authentication runtime, persisted session, strict Effect authentication BFF, Core
principal resolution, authenticated home state, or logout behavior.

Authentication is a cross-cutting Shell/Core responsibility, not a business domain.
Implementing it as an Auth MicroVertical would create a false vertical boundary,
incorrectly expose authentication as a separately owned business capability, and
contradict the accepted product statement that Shell and Core determine whether a
Better Auth session represents a logged-in OntOS user.

## Current Reverted Baseline

Re-opened against the reverted workspace on 2026-07-30. The current implementation
baseline is:

- the Shell login page performs only local required-field validation and makes no
  authentication request;
- the Shell home page still renders its hero, showcase, calls to action, and build
  markers;
- the Shell has no `api/index.ts`, `shared/api.ts`, generated authentication client,
  Better Auth dependency, Auth Drizzle model, Auth migration, or authentication test
  suite;
- Core already owns tenants, principals, and `principal_auth_bindings`, but it has no
  Better Auth subject resolver;
- root database commands currently delegate only to `@app/core-runtime`;
- no Auth MicroVertical source is tracked, but ignored residual directories, build
  output, dependency links, and caches remain under `verticals/auth/` from the reverted
  implementation attempt.

All implementation tasks, acceptance criteria, and review checks below are therefore
intentionally open. No prior implementation or validation evidence may be reused.

## Solution Statement

Add authentication directly to the Shell/Core boundary:

- Shell owns Better Auth credential and session mechanics, the `auth` PostgreSQL
  schema, the strict Effect authentication BFF, cookie propagation, login/logout UI,
  and current-session presentation.
- Core owns only the non-secret Better Auth subject binding, active
  principal-and-tenant resolution, and the safe identity DTO needed by the Shell.
- No Auth MicroVertical, Auth remote, Auth delivery unit, `@app/auth` package, or
  `verticals/auth/**` files may be introduced.

The Shell BFF exposes only declared `signIn`, `currentSession`, and `signOut`
operations through Effect Schema and a generated Shell client. `signIn` validates
credentials and creates a session only when Core resolves exactly one active binding.
`currentSession` revalidates the Core identity on every read. `signOut` delegates to
Better Auth and forwards every cookie-clearing `Set-Cookie` header.

The home route consumes the Shell authentication client and renders exactly one of the
two required visible states. It must not retain the current hero, showcase,
promotional calls to action, build markers, or other visible content.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — limits work to `app/` and defines mandatory Codesmith generator use.
- `AGENTS.md` — defines strict Effect BFF, typed error, Action, database, and frontend boundaries.
- `README.md` — documents the supported strict Effect API topology and workspace commands.
- `docs/architecture/ULTRAMODERN.md` — requires generated initial business files and wiring.
- `docs/architecture/ERRORS.md` — defines typed Effect errors and HTTP Problem Details.
- `docs/architecture/DATABASE.md` — defines typed Drizzle access and schema ownership.
- `docs/architecture/ACTIONS.md` — defines Action rules and the narrow credential/session lifecycle exception.
- `docs/frontend/FRONTEND.md` — defines Shell route, generated-client, i18n, accessibility, and error-state requirements.
- `../docs/09_AUTHN_AUTHZ_MODEL.md` — assigns authentication/session mechanics to Better Auth and non-secret principal bindings to Core.
- `../docs/adr/0014-authenticated-principal-session.md` — states that Shell and Core jointly determine logged-in OntOS state.
- `apps/shell-super-app/modern.config.ts` — Shell configuration that must host the strict Effect authentication BFF.
- `apps/shell-super-app/package.json` — Shell-owned Better Auth, Effect, Drizzle, and test scripts.
- `apps/shell-super-app/src/routes/[lang]/login/page.tsx` — localized login UI.
- `apps/shell-super-app/src/routes/[lang]/page.tsx` — exact anonymous/authenticated home states and logout interaction.
- `apps/shell-super-app/src/api/vertical-clients.ts` — existing vertical client registry that authentication must not use.
- `apps/shell-super-app/locales/en/shell.json` — English authentication, identity, logout, and error copy.
- `apps/shell-super-app/locales/cs/shell.json` — Czech authentication, identity, logout, and error copy.
- `apps/shell-super-app/tests/unit/routes/login/page.test.tsx` — existing login component coverage.
- `apps/shell-super-app/tests/e2e/login.spec.ts` — existing localized browser coverage.
- `packages/core-runtime/src/db/schema.ts` — Core-owned tenants, principals, and principal auth bindings.
- `packages/core-runtime/src/db/catalog.ts` — exact Core schema inventory.
- `packages/core-runtime/src/index.ts` — public Core boundary for the narrow resolver.
- `packages/core-runtime/tests/unit/*.test.ts` — current Core schema and configuration tests.
- `package.json` — workspace database and validation command composition.
- `topology/ownership.json` — must continue to show Shell/Core ownership and no Auth vertical.
- `topology/reference-topology.json` — must contain no Auth vertical, remote, or deployment unit.
- `verticals/auth/` — ignored residue from the reverted vertical attempt that must be removed and must not be recreated.

### New Files

- `apps/shell-super-app/api/index.ts` — generator-created strict Effect Shell BFF runtime entry.
- `apps/shell-super-app/shared/api.ts` — generator-created Shell authentication contract.
- `apps/shell-super-app/src/api/auth-client.ts` — generator-created Shell authentication client.
- `apps/shell-super-app/api/auth/service.ts` — Shell-private Effect adapter for Better Auth server calls and cookie headers.
- `apps/shell-super-app/api/auth/errors.ts` — typed Shell authentication failures.
- `apps/shell-super-app/api/auth/config.ts` — environment-validated Better Auth server configuration.
- `apps/shell-super-app/api/auth/db/schema.ts` — Better Auth CLI-derived Drizzle tables rooted in `pgSchema("auth")`.
- `apps/shell-super-app/api/auth/db/client.ts` — Shell-private typed Drizzle/Effect database service.
- `apps/shell-super-app/api/auth/db/catalog.ts` — exact Better Auth schema inventory published for workspace verification.
- `apps/shell-super-app/drizzle.auth.config.ts` — Shell-owned Better Auth Drizzle Kit configuration.
- `apps/shell-super-app/drizzle-auth/*.sql` — generated migration for the `auth` schema.
- `apps/shell-super-app/src/routes/[lang]/page.data.ts` — server loader for initial current-session state.
- `apps/shell-super-app/tests/unit/routes/home/page.test.tsx` — exact home-state and logout component coverage.
- `apps/shell-super-app/tests/unit/auth-contract.test.ts` — Shell BFF schema and typed-error coverage.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — Better Auth, Core resolution, session, and cookie integration coverage.
- `packages/core-runtime/src/auth/principal-resolver.ts` — narrow Better Auth subject-to-principal/tenant resolver.
- `packages/core-runtime/src/auth/principal-resolver-errors.ts` — typed missing, ambiguous, and inactive identity failures.
- `packages/core-runtime/tests/integration/principal-resolver.test.ts` — database-backed binding and tenant-isolation coverage.
- `scripts/verify-application-db-schema.mts` — composed exact verification for Core-owned `core` and Shell-owned `auth` schemas.

## Implementation Plan

### Phase 1: Foundation

Resolve the Shell BFF scaffold blocker before creating any initial API files. Configure
the Shell as the authentication BFF and Better Auth database owner without adding a
vertical, remote, package, or delivery unit. Pin compatible Better Auth/Drizzle
dependencies, generate the Better Auth model, and establish independent Core and
Shell-owned schema inventories and migration histories.

### Phase 2: Core Implementation

Implement and test the narrow Core subject resolver. Configure Better Auth inside the
Shell, enforce Core resolution before session creation and on every session read, and
implement declared `signIn`, `currentSession`, and `signOut` Shell BFF operations with
typed errors, redacted logging, and correct cookie propagation.

### Phase 3: Integration

Connect the localized Shell login and home routes through the generated Shell
authentication client. Reduce the home route to its exact anonymous/authenticated
states, implement logout and retry behavior, and prove the complete localized flow
with unit, database integration, contract, and browser tests.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Resolve the Shell BFF generator blocker

- [ ] Add or obtain a Codesmith/UltraModern generator that creates the initial strict Effect BFF contract, runtime entry, generated client, Modern.js wiring, and topology metadata inside `apps/shell-super-app`; do not hand-create the initial Shell BFF files.
- [ ] Confirm the generated result remains part of the existing `shell-super-app` delivery unit and creates no entry under `verticals/`, no `@app/auth` package, no Module Federation Auth remote, and no Auth deployment unit.
- [ ] Stop and revise this plan if the only available generator creates a MicroVertical; authentication must remain in Shell/Core.

### 2. Establish Shell/Core authentication ownership

- [ ] Remove the residual ignored `verticals/auth/` directory, including its build output, dependency links, and caches; verify it contains no user-owned or tracked source before removal and do not replace it with another Auth vertical.
- [ ] Record in the authoritative application architecture documentation that authentication is a Shell/Core capability and must never be modeled as a MicroVertical.
- [ ] Configure the existing Shell package to own Better Auth runtime dependencies, strict Effect BFF configuration, auth database scripts, and environment validation.
- [ ] Keep Core free of credentials, password hashes, session tokens, cookies, and Better Auth runtime dependencies; Core exposes only the non-secret resolver contract and safe DTO.
- [ ] Add topology/ownership contract tests that fail if `verticals/auth`, `@app/auth`, an Auth remote, an Auth delivery unit, or stale Auth-vertical build/dependency artifacts appear.

### 3. Generate and verify the Shell-owned Better Auth schema

- [ ] Pin repository-compatible Better Auth, Better Auth CLI, Drizzle, and PostgreSQL dependencies in the Shell package.
- [ ] Use the pinned Better Auth CLI to generate its Drizzle model, adapt every table to one `pgSchema("auth")`, and pass the complete generated model to the Better Auth adapter.
- [ ] Generate the Shell-owned SQL migration with Drizzle Kit; verify it creates only the Better Auth tables in `auth` and does not alter `public` or `core`.
- [ ] Compose Core and Shell migration/verification scripts while retaining separate configurations, journals, and exact owner-published catalogs.
- [ ] Add schema contracts and clean-database tests that apply both histories twice and reject unexpected tables or application schemas.

### 4. Resolve Better Auth subjects through Core

- [ ] Implement an Effect-based Core resolver over `principal_auth_bindings`, principals, and tenants for provider `better_auth`, subject type `user`, and Better Auth user id.
- [ ] Return only safe immutable identity fields: email/login, optional display name, `principalId`, `tenantId`, and any already-approved non-secret display fields.
- [ ] Fail closed with typed errors for missing or multiple bindings, revoked/inactive bindings, inactive principals, and suspended/archived tenants.
- [ ] Add unit and PostgreSQL integration tests for success, every failure state, duplicate bindings, tenant isolation, and revocation after session creation.

### 5. Implement the Shell authentication BFF

- [ ] Configure Better Auth email/password support in the Shell with validated database URL, secret, base URL, trusted origins, secure cookie settings, and production-safe defaults.
- [ ] Enforce Core resolution before Better Auth accepts a session and on every `currentSession` read.
- [ ] Define and implement `POST signIn`, `GET currentSession`, and `POST signOut` in the generated Shell Effect contract/runtime; use Effect Schema for every request, success response, and declared error.
- [ ] Forward incoming cookies and all required `Set-Cookie` headers, including every cookie-clearing header from `signOut`.
- [ ] Map malformed input to `400`, invalid credentials to one non-enumerating `401`, unresolved/inactive OntOS identity to `403`, retryable availability failures to `503`, and unexpected safe failures to `500`.
- [ ] Keep the raw Better Auth handler private, expose no signup or catch-all route, and prevent passwords, hashes, tokens, cookies, or Better Auth records from entering logs or Problem Details.
- [ ] Regenerate the Shell client and add contract/runtime tests for schema decoding, error statuses, redaction, multiple cookie headers, session invalidation, expired-session logout, and transport failures.

### 6. Connect the Shell login and exact home states

- [ ] Submit the localized login form through the generated Shell `signIn` client operation, prevent duplicate submission, preserve accessible validation/focus behavior, and redirect to the localized home route on success.
- [ ] Load `currentSession` through the generated Shell client on the server so the home route does not flash the wrong state.
- [ ] Remove the hero, showcase, promotional calls to action, build markers, and every other visible home-page element.
- [ ] For `anonymous`, render exactly one localized link to `/login` and no other visible home content.
- [ ] For `authenticated`, render only safe logged-in identity fields and one localized logout button; do not render the anonymous login link.
- [ ] Invoke the generated Shell `signOut` operation when logout is clicked, prevent duplicate clicks while pending, clear stale identity state after success, and leave only the login link.
- [ ] Preserve authenticated state when logout fails, show localized retryable feedback, and keep the logout control accessible.
- [ ] Verify keyboard, screen-reader, narrow-viewport, expired-session, forbidden-session, loading, and retry behavior with existing UI-kit components and tokens.

### 7. Add end-to-end authentication coverage

- [ ] Add deterministic fixtures that create a Better Auth user through the Shell-owned server API and create the matching Core tenant, principal, and binding through owner-supported helpers.
- [ ] Add home route tests proving the exact anonymous and authenticated contents and the absence of unrelated or sensitive content.
- [ ] Extend English and Czech Playwright flows for invalid login, valid login, session persistence, logout, anonymous persistence after reload, duplicate logout clicks, logout failure/retry, and responsive/keyboard behavior.
- [ ] Add boundary assertions proving the browser uses only the generated Shell client and no Auth MicroVertical artifact, endpoint, remote, package, or topology entry exists.

### 8. Run all validation commands

- [ ] From `app/`, execute every command in Validation Commands in order and resolve every failure without modifying `mvp/` or `mvp2/`.
- [ ] Inspect `git diff --check`, generated Shell BFF/client output, migration SQL, topology, ownership, and final `git status`; confirm no authentication vertical was introduced.

## Testing Strategy

### Unit Tests

Test Core resolver decisions; Better Auth table placement; Shell Effect request,
response, and error schemas; generic credential errors; sign-out cookie invalidation;
redaction; exact home-page contents; logout pending/retry behavior; and the absence of
Auth vertical ownership.

### Integration Tests

Run PostgreSQL-backed tests for independent Core and Shell migration histories, exact
catalog verification, Better Auth credential/session behavior, Core resolution,
revocation, and cookie propagation/clearing through the Shell strict Effect BFF. Run
Playwright against the assembled Shell for the complete English and Czech login,
current-session, and logout flow.

### Edge Cases

- A valid Better Auth user has no Core binding or multiple active bindings.
- The binding, principal, or tenant becomes inactive before or after session creation.
- Unknown email and wrong password produce the same public response.
- A cookie is missing, expired, malformed, or valid in Better Auth but stale in Core.
- Logout is clicked repeatedly, retried after failure, or receives an expired session.
- Logout succeeds but stale client state or a reload attempts to reuse the old cookie.
- Better Auth or PostgreSQL is temporarily unavailable.
- The BFF receives or emits multiple cookie headers.
- A generated Shell client response fails schema decoding.
- A developer attempts to introduce `verticals/auth`, `@app/auth`, or Auth topology/Module Federation ownership.
- English and Czech routes render consistently at narrow and wide viewports.

## Acceptance Criteria

- [ ] Authentication is implemented only in the existing Shell and Core boundaries; no Auth MicroVertical, residual `verticals/auth/**` directory, `@app/auth` package, Auth remote, or Auth delivery unit exists.
- [ ] Architecture documentation clearly states that authentication is a Shell/Core capability and must not be implemented as a vertical.
- [ ] Shell owns Better Auth credentials, sessions, cookies, strict Effect authentication BFF, generated client, `auth` schema, and Auth migration history.
- [ ] Core owns only principal auth bindings and active principal/tenant resolution; it stores no credentials or runtime session secrets.
- [ ] A Better Auth session is logged-in OntOS state only when exactly one active Core binding resolves to an active principal in an active tenant.
- [ ] The Shell exposes only declared `signIn`, `currentSession`, and `signOut` operations and exposes no raw Better Auth or signup route.
- [ ] Anonymous home renders only one localized login-page link.
- [ ] Authenticated home renders only safe logged-in identity fields and one localized logout button.
- [ ] Clicking logout invalidates the Better Auth session, clears its browser cookie, removes the identity/logout UI, and leaves only the login link.
- [ ] Reloading after logout remains anonymous.
- [ ] Failed logout preserves the authenticated state and offers accessible localized retry behavior.
- [ ] No password, hash, token, cookie value, or Better Auth internal record appears in UI, client responses, logs, or Problem Details.
- [ ] Unit, integration, contract, browser, i18n, accessibility, responsive, build, and repository validation pass with zero regressions.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `docker compose config` — validate the PostgreSQL test service configuration.
- `mise exec -- pnpm install --frozen-lockfile` — verify the lockfile and dependency graph.
- `mise exec -- pnpm db:migrate` — apply Core and Shell-owned Auth migrations.
- `mise exec -- pnpm db:verify` — exact-match the Core and Auth schema inventories.
- `mise exec -- pnpm db:test` — run schema, migration, resolver, and database integration tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — run Shell login, home, Auth contract, and logout unit tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — run localized login/session/logout browser flows.
- `mise exec -- pnpm api:check` — verify strict Effect Shell BFF topology and generated client boundaries.
- `mise exec -- pnpm i18n:boundaries` — verify English/Czech locale parity and ownership.
- `mise exec -- pnpm contract:check` — verify topology, ownership, packages, and the absence of an Auth vertical.
- `mise exec -- pnpm typecheck` — type-check the workspace and generated contracts.
- `mise exec -- pnpm build` — build the Shell with its authentication BFF.
- `mise exec -- pnpm check` — run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] Authentication remains a Shell/Core capability and no Auth MicroVertical boundary exists.
- [ ] Action, generated Shell BFF client, typed Effect error, database, and principal-resolution boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, sensitive data exposure, or accidental API expansion remains.

## Notes

- **Non-negotiable architecture decision:** authentication belongs to Shell/Core and must not be implemented as a MicroVertical. Do not run a MicroVertical generator for Auth and do not add anything under `verticals/auth`.
- **Reverted baseline:** the prior authentication implementation has been rolled back. Treat every task and acceptance criterion as pending, and do not rely on previous generated files, test results, or implementation evidence.
- **Residual cleanup:** `verticals/auth/` currently contains only ignored remnants of the reverted attempt. Resolve and remove those remnants before implementation so they cannot be mistaken for an allowed Auth vertical.
- **Blocking generator decision:** the current workspace has no discovered Codesmith command that scaffolds a strict Effect BFF into the existing Shell. Because initial business files and wiring must be generated, implementation cannot create `api/index.ts`, `shared/api.ts`, or the client by hand. Add/provide a Shell BFF generator before implementation.
- Shell ownership of Better Auth mechanics does not make credentials part of Core. Core owns only non-secret identity bindings and principal/tenant resolution, consistent with `../docs/09_AUTHN_AUTHZ_MODEL.md`.
- Better Auth credential/session creation and invalidation use the approved narrow authentication lifecycle exception to the business Action rule. OntOS business state changes remain Actions.
- “Credentials about the logged user” means safe identity information: email/login, optional display name, `principalId`, and `tenantId`. It never means passwords, hashes, cookies, tokens, or full Better Auth records.
- “Only” refers to all user-perceivable home-page content, including screen-reader content. Route head metadata and framework integration may remain only when they produce no additional perceivable home content.
- V0 requires exactly one active binding because the login page has no tenant selector. Tenant switching is a separate feature.
- Signup, password reset, email verification UI, social providers, API keys, impersonation, and tenant switching are out of scope.
