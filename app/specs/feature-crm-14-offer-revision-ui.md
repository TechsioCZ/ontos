---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 14 Offer revision UI

## Feature Description

Implement ticket 14, "Implement the Offer revision UI," from `app/tickets.md`. Extend Deal details
with deterministic Offer revision list/detail and create, Draft-edit, and soft-delete flows using
completed generated Offer clients. Revision and status are display-only, only active Drafts are
editable, all required typed states/locales/accessibility/responsive/tests are included, and no CRM
search capability is added.

## User Story

As a CRM sales user
I want to inspect and maintain Draft Offer revisions under a Deal
So that commercial terms are traceable and terminal proposals remain readable

## Problem Statement

Offer revisions exist only through backend contracts. The UI must make immutable revision/status
clear, allow editing only Drafts, localize money/date input, separate deletion/lifecycle controls,
and retain Deal context through all typed failures and responsive layouts.

## Solution Statement

Extend the Deal workspace with UI-kit Table/list, Badge, FormInput, FormTextarea, FormNumericInput,
Dialog, Button, StatusText, and Toast components driven by generated read/Action clients. Use Figma
file `GWzuNz24M0GzeOgGtuylj1`, page `Pre-Alpha Repo`, only for general nested revision list/detail,
form/dialog, and action placement—not business requirements or visual styling.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Offer revision UI behavior and fields.
- `tickets.md` — corresponding ticket 14; blocked by tickets 10 and 13.
- `verticals/crm/src/routes/[lang]/deals/page.tsx` and `page.data.ts` — Deal workspace integration.
- `verticals/crm/src/deals/deal-workspace.tsx` — parent detail presentation.
- `verticals/crm/src/api/` — generated Offer list/detail/Create/Edit/Delete Effect clients.
- `verticals/crm/locales/en/` and `verticals/crm/locales/cs/` — Offer copy.
- `docs/frontend/FRONTEND.md` and `docs/frontend/FIGMA.md` — frontend/structural rules.
- `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=4-2&p=f&t=lootc1Zy6fQ1JzON-0` — `Pre-Alpha Repo` page only.

### New Files

- `verticals/crm/src/offers/offer-view-model.ts` — revision list/detail/form UI states.
- `verticals/crm/src/offers/offer-revisions-panel.tsx` — UI-kit presentation.
- `verticals/crm/tests/unit/offer-revision-ui.test.tsx` — component/error/form tests.
- `verticals/crm/tests/unit/routes/deals/offer-integration.test.tsx` — route/client/URL tests.

## Implementation Plan

### Phase 1: Foundation

Extend Deal URL/view models with Offer cursor/selection, immutable revision/status display, Draft
capabilities, localized money/date, and exhaustive typed state mapping.

### Phase 2: Core Implementation

Render nested revisions and create/edit/delete interactions using UI kit; only active Drafts expose
edit/delete and forms omit revision/status/deletion/trusted scope.

### Phase 3: Integration

Compose generated Effects in route/feature code, preserve Deal context and safe input, refetch after
success/conflict, localize all copy, and test accessibility/responsive/read-only/no-search behavior.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define Offer route and view-model states

- [ ] Add bounded Offer cursor and selected Offer ID under selected Deal URL state; invalid/foreign/deleted selection maps to validation/not-found without losing Deal context.
- [ ] Map loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, success, and read-only/deprecated states from generated clients.
- [ ] Define plain revision rows/details/forms/capabilities/callbacks; presentation receives no Effects, BFF/domain errors, routing, or query objects.

### 2. Render deterministic revisions and details

- [ ] Show Offer revisions in backend order with immutable localized revision label, status Badge, title, amount/currency, validity, and direct detail; provide clear empty state and responsive stacked/table semantics.
- [ ] Keep terminal/non-Draft/tombstone historical views readable with safe labels while ordinary deleted Offers are absent; only active Draft shows edit/delete capabilities.
- [ ] Do not add Offer or CRM search controls, queries, providers, or fuzzy filtering.

### 3. Implement create and Draft-edit forms

- [ ] Use FormInput/FormTextarea/FormNumericInput for title, description, amount, currency, and validity date with locale-aware numeric/date validation. Revision/status/deletion/scope are never input fields.
- [ ] Handle inline validation/focus, pending/duplicate prevention, value preservation, forbidden/not-found/conflict/unavailable outcomes, and success refetch/selection/Toast through generated clients.
- [ ] For non-Draft current state returned during edit, close or disable mutation with a localized conflict explanation and refreshed readable state.

### 4. Implement explicit Draft deletion

- [ ] Keep delete separate with a danger confirmation Dialog naming revision/title, loading semantics, cancel focus return, and no implication that Deal/Activities/history are deleted.
- [ ] Map typed validation, forbidden, not-found, conflict, unavailable/retry, and success; preserve parent Deal view after completion.

### 5. Localize and test

- [ ] Add English/Czech revision/status display, fields, money/date, empty/loading/errors/retry/delete/success, read-only, and accessible copy.
- [ ] Add component/route tests for loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, success, deterministic pagination/URL selection, Draft versus non-Draft capabilities, immutable-field absence, localized numeric/date input, deletion confirmation, keyboard/focus, narrow/long content, read-only/deprecated states, Deal context preservation, and no search.

### 6. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Test Offer capability/view/error mapping, immutable display, Draft forms/dialogs, money/date locale,
accessibility/focus, responsive semantics, translations, and no-search/lifecycle-form exclusions.

### Integration Tests

Route tests mock generated Offer clients to prove nested pagination/selection, parent Deal context,
Draft conflict refresh, mutation invalidation, retry, typed transport/decode failures, and success.

### Edge Cases

- Offer becomes Sent while Draft edit dialog is open.
- Parent Deal or selected Offer disappears.
- Revision numbers have gaps after soft deletion.
- Amount/date/currency is invalid for locale.
- Very long title/description on narrow viewport.

## Acceptance Criteria

- [ ] Deal details show deterministic Offer revisions with immutable revision/status labels.
- [ ] Users can create and edit only active Draft fields and explicitly delete Drafts through generated clients.
- [ ] Terminal/non-Draft records remain readable; all typed states/locales/accessibility/responsive/tests pass.
- [ ] No CRM search UI or behavior exists.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Offer revision component/route tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck Offer UI/client integration.
- `mise exec -- pnpm i18n:boundaries` — validate Offer translations.
- `mise exec -- pnpm api:check` — verify generated Effect clients only.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 10 and 13 must both be complete.
- Figma is structural input from `Pre-Alpha Repo` only; UI-kit owns appearance.
- Ticket 16 owns lifecycle controls; PDFs, files, line items, products, sending, and search are out of scope.
