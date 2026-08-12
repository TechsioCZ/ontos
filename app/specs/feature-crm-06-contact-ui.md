---
type: feature
status: done
created: 2026-08-10
---

# Feature: CRM 06 Contact UI

## Feature Description

Implement ticket 6, "Implement the Contact UI," from `app/tickets.md`. Extend the Customer workspace
with a paginated semantic Contact list, direct Contact detail, and create/edit/soft-delete flows
using only completed generated Contact Effect clients. Keep primary designation entirely out of
ordinary Contact forms and add no CRM search capability.

## User Story

As a CRM user
I want to maintain a Customer's Contacts in context
So that I can reach the right people without leaving the Customer workspace

## Problem Statement

Contacts are callable but not exposed in the Customer workspace. The UI must preserve Customer
context, handle long/partial names and narrow layouts, separate deletion, and exhaustively present
typed loading/empty/error/success states without conflating ordinary editing with primary status.

## Solution Statement

Consume the Contact operations added to the generated Customer-directory/Action clients. Compose
UI-kit Table, FormInput, Dialog, Button, StatusText, and Toast components inside the existing
Customer route. Use Figma file `GWzuNz24M0GzeOgGtuylj1`, page `Pre-Alpha Repo`, solely for general
master-detail, nested list, form/dialog, and action placement—not requirements or visual styling.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Contact UI behavior and states.
- `tickets.md` — corresponding ticket 6; blocked by tickets 4 and 5.
- `verticals/crm/src/routes/[lang]/customers/page.tsx` — existing Customer workspace.
- `verticals/crm/src/routes/[lang]/customers/page.data.ts` — generated-client route integration.
- `verticals/crm/src/api/` — generated Contact read/Action Effect clients.
- `verticals/crm/locales/en/` and `verticals/crm/locales/cs/` — all user-facing/accessibility copy.
- `docs/frontend/FRONTEND.md` — presentation and typed client rules.
- `docs/frontend/FIGMA.md` — structural-only Figma use.
- `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=4-2&p=f&t=lootc1Zy6fQ1JzON-0` — `Pre-Alpha Repo` page only.

### New Files

- `verticals/crm/src/contacts/contact-view-model.ts` — plain nested-list/detail/form UI states.
- `verticals/crm/src/contacts/contact-panel.tsx` — reusable UI-kit presentation.
- `verticals/crm/tests/unit/contact-ui.test.tsx` — component/accessibility/interaction tests.
- `verticals/crm/tests/unit/routes/customers/contact-integration.test.tsx` — route/client/URL tests.

## Implementation Plan

### Phase 1: Foundation

Extend Customer route URL and view models with Contact pagination/selection and exhaustive typed
state mapping while keeping Customer context stable.

### Phase 2: Core Implementation

Render the Contact list/detail and create/edit/delete dialogs with UI-kit components and semantic
callbacks. Forms cover only names, email, phone, and job title.

### Phase 3: Integration

Compose generated client Effects in route/feature code, refetch after mutations, localize all copy,
and verify responsive, focus, long-content, read-only, and error behavior.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Extend route and plain UI states

- [x] Add bounded Contact cursor and selected Contact ID to URL-backed Customer workspace state without losing selected Customer/page state; reject invalid or foreign Contact selections as validation/not-found states.
- [x] Map Contact loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, success, and read-only module states exhaustively from generated client errors/results.
- [x] Define presentation props/callbacks independent of Effects, routing, query caches, domain errors, and BFF response types.

### 2. Render nested Contact list and detail

- [x] Add a semantic paginated Contact table/list with a clear empty state, accessible label/caption, usable first/last-name fallback, email/phone/job-title display, and direct detail selection.
- [x] Preserve Customer context during Contact selection/mutation and use a stacked narrow-layout presentation with sensible long-name wrapping and logical heading/focus order.
- [x] Do not add search inputs, filters that behave as search, search query parameters, providers, or keyboard search shortcuts.

### 3. Add create and edit interactions

- [x] Build create/edit dialogs using `FormInput` for first name, last name, email, phone, and job title; omit Customer reassignment, primary designation, deletion, and trusted scope fields.
- [x] Associate inline validation/status copy, focus the first invalid field/summary, preserve values on validation or unavailable failures, prevent duplicate submissions, and distinguish pending from completed state.
- [x] On success, refetch/invalidate through generated clients, retain surrounding Customer and Contact selection coherently, return focus, and announce localized success.

### 4. Add explicit Contact deletion

- [x] Use a separate danger confirmation Dialog naming the Contact and explaining soft deletion; cancel returns focus and delete never appears in edit fields.
- [x] Handle forbidden, not-found, stale conflict, unavailable/retry, and success distinctly; after success remove only the Contact from ordinary UI and keep the Customer view.

### 5. Localize and test every state

- [x] Add complete English/Czech visible/accessibility copy, including partial-name fallbacks, field issues, confirmations, retry, and read-only explanations.
- [x] Add component/route tests for loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, success, pagination/URL state, direct detail, pending controls, delete confirmation, keyboard/focus, long names, narrow layout, Customer context preservation, read-only/deprecated modules, and absence of Contact/CRM search.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Test Contact view models, partial-name formatting, typed error mapping, forms/dialogs, focus/keyboard,
responsive semantics, locales, and absence of primary/search controls.

### Integration Tests

Route tests mock generated Effect clients to prove nested pagination/selection, Customer-context
preservation, mutation refetch, conflict recovery, retry, and typed decode/transport handling.

### Edge Cases

- Contact has only first or last name.
- Selected Contact disappears or belongs to another Customer.
- Very long names/job titles render on a narrow viewport.
- Delete/edit becomes stale while a dialog is open.
- Module becomes read-only while data remains readable.

## Acceptance Criteria

- [x] Customer details show a paginated Contact list, clear empty state, and direct Contact detail.
- [x] Users can create/edit agreed Contact fields and explicitly confirm soft deletion without changing primary designation.
- [x] All required typed states, translations, accessibility, focus, responsive, long-content, and route/component tests pass.
- [x] No CRM search UI or behavior exists.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Contact component/route/view-model tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck Contact UI integration.
- `mise exec -- pnpm i18n:boundaries` — verify English/Czech Contact copy.
- `mise exec -- pnpm api:check` — verify generated Effect clients are the only backend seam.
- `mise exec -- pnpm module-entrypoints:check` — verify the Customer page remains governed.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 4 and 5 must both be complete.
- Figma is structural input from `Pre-Alpha Repo` only; UI-kit owns appearance.
- Primary Contact controls are deliberately deferred to ticket 8.

## Implementation Evidence

### Summary

- Extended the generated Customer workspace with URL-backed Contact pagination and selection,
  generated Contact directory reads, direct detail, and generated create/edit/delete Action clients.
- Added plain Contact view models plus a reusable UI-kit presentation for semantic desktop and
  narrow lists, detail, validation, read-only states, dialogs, soft-delete confirmation, focus, and
  localized toasts.
- Added complete English/Czech copy and focused component/route coverage for the required state,
  URL, mutation, accessibility, responsive, long-content, and no-search behavior.

### Changed Files and Diff Stat

- `verticals/crm/src/contacts/**`: plain Contact UI contracts and reusable UI-kit presentation.
- Customer route/view-model files: generated-client reads, Actions, URL state, typed error mapping,
  mutation refetch, and workspace composition.
- CRM locale and unit-test files: complete English/Czech copy and state/interaction coverage.
- `specs/feature-crm-06-contact-ui.md`: completed checklist and implementation evidence.
- Diff stat: 14 files changed, 3,172 insertions(+), 214 deletions(-).

### Tests and Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — PASS: Node 24/24 and Rstest 62/62.
- `mise exec -- pnpm --filter @app/crm typecheck` — PASS.
- `mise exec -- pnpm i18n:boundaries` — PASS.
- `mise exec -- pnpm api:check` — PASS.
- `mise exec -- pnpm module-entrypoints:check` — PASS.
- `mise exec -- pnpm check` — PASS, including format, lint, Actions, types, boundaries, contracts,
  and performance readiness.
- `GIT_DIR=<isolated nonexistent path> ULTRAMODERN_SOURCE_REVISION=6be91cd14679621dcc2d6572f0aa8b416ec275e6 mise exec -- pnpm build` — PASS for CRM, Shell, Module Federation types, deploy packaging, and performance readiness.
- Production runtime review — PASS for the independently served `/en/customers` route, hydration,
  localized explicit unavailable/retry UI, and built assets. Authenticated Contact CRUD could not be
  exercised without local trusted Shell/data services and is covered by 31 focused component/route
  tests instead. Screenshot: `.codex/reports/review/feature-crm-06-contact-ui/runtime-unavailable.png`.

### Review Evidence

- Re-reviewed the completed diff against this specification, root/app `AGENTS.md`, the CRM master
  specification/ticket, and all referenced MicroVertical, Action, error, data-access, database,
  outbox, module-entrypoint, module-manifest, UltraModern, frontend, and Figma guidance.
- Spec/acceptance review: PASS after preserving the Customer workspace during nested Contact loading
  and adding deferred navigation/mutation refetch coverage for focus, context, and refreshed data.
- Standards/architecture review: PASS after retaining inferred operation-specific Effect failures,
  exhaustively mapping exact tags, sharing the headless Customer/Contact CRUD lifecycle, and fixing
  declaration-only Module Federation type generation. All business calls use the generated Contact
  Effect clients; no search, primary controls, native primitive replacements, cross-owner imports,
  private exports, or unrelated expansion remain.
- No Codesmith generator was required: the generated Customer page already existed, no Action/page/
  outbox/policy was created, and this approved spec explicitly names the four new private UI/test files.

### Deviations and Notes

- Figma MCP metadata remained unavailable because the connected View seat exhausted its call
  allowance, but the open desktop Figma app was inspected read-only. `Pre-Alpha Repo` confirmed only
  structural cues: stable surrounding context, clear detail hierarchy, adjacent list/detail content,
  and explicit loading/read-only/error variants. No Figma visual styling was copied; installed
  `@techsio/ui-kit` APIs own appearance.
- A dirty worktree cannot infer a promotable release revision, so the production build used the
  repository's documented isolated-Git pattern with the exact base revision. Generated build output
  remains ignored.
