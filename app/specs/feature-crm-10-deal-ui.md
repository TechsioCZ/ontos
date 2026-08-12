---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 10 Deal UI

## Feature Description

Implement ticket 10, "Implement the Deal UI," from `app/tickets.md`. Adapt the generated private
Deals page into a paginated, exact-Customer-filtered Deal list/detail workspace with create, edit,
and soft-delete flows. Consume only completed generated Deal/Customer/Contact Effect clients,
exclude status from ordinary forms, and provide all typed states, localization, accessibility, and
responsive behavior without search.

## User Story

As a CRM sales user
I want to view and maintain Deals for the selected Legal Entity
So that expected commercial work is organized by Customer without changing lifecycle accidentally

## Problem Statement

The Deal backend has no presentation. The UI must keep selected Legal Entity context, constrain
optional Contacts to the selected Customer, separate deletion/status changes, support localized
money/date input, and distinguish all typed read/mutation outcomes.

## Solution Statement

Use the generated Deals page and completed Deal workspace/Action clients. Compose UI-kit Table,
Select, FormInput, FormTextarea, FormNumericInput, Badge, Dialog, Button, StatusText, and Toast.
Use Figma file `GWzuNz24M0GzeOgGtuylj1`, page `Pre-Alpha Repo`, only for general list/detail/filter,
form/dialog, and action placement—not product requirements, appearance, or styling.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Deal UI fields, states, and component choices.
- `tickets.md` — corresponding ticket 10; blocked by ticket 9.
- `verticals/crm/src/routes/[lang]/deals/page.tsx` — generated private Deals page.
- `verticals/crm/src/routes/[lang]/deals/route.meta.ts` — private governed route contract.
- `verticals/crm/src/api/` — generated Deal/Customer/Contact read and Action Effect clients.
- `verticals/crm/locales/en/` and `verticals/crm/locales/cs/` — Deal UI copy.
- `docs/frontend/FRONTEND.md` and `docs/frontend/FIGMA.md` — frontend and structural-design rules.
- `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=4-2&p=f&t=lootc1Zy6fQ1JzON-0` — `Pre-Alpha Repo` page only.

### New Files

- `verticals/crm/src/routes/[lang]/deals/page.data.ts` — route/client loading and typed state mapping.
- `verticals/crm/src/deals/deal-view-model.ts` — list/detail/filter/form states.
- `verticals/crm/src/deals/deal-workspace.tsx` — UI-kit presentation.
- `verticals/crm/tests/unit/deal-ui.test.tsx` — component/accessibility/mutation tests.
- `verticals/crm/tests/unit/routes/deals/*.test.tsx` — loader/URL/client tests.

## Implementation Plan

### Phase 1: Foundation

Define URL-backed cursor, exact Customer filter, selected Deal, view models, localized status labels,
and exhaustive generated-client error mappings.

### Phase 2: Core Implementation

Build semantic list/detail, create/edit forms, and explicit deletion using UI-kit components. Status
is display-only and Contact options follow selected Customer.

### Phase 3: Integration

Compose generated Effects in route/feature code, refetch after mutations, preserve safe input on
recoverable failures, and test localization, keyboard/focus, responsive/read-only, and no-search.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define route and view-model state

- [ ] Parse/serialize bounded Deal cursor, exact Customer ID filter, and selected Deal ID in the URL; invalid/foreign/stale values map to validation/not-found without becoming free-text search.
- [ ] Compose generated read clients and map loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, and resolved/read-only states before presentation.
- [ ] Define plain rows/details/forms/options/mutation states; presentation receives semantic callbacks and no Effects, query objects, routing, or domain/BFF errors.

### 2. Build list, filter, and detail without search

- [ ] Render a semantic paginated Deal Table/list with exact Customer Select filter, localized status Badge, Customer, expected value/currency, expected close date, and direct detail selection.
- [ ] Provide clear unfiltered/filtered empty states, responsive stacked layout, long-title/description handling, accessible captions/headings, and coherent URL navigation.
- [ ] Do not add free-text search input, search provider, search query parameter, shortcut, fuzzy match, or hidden search behavior.

### 3. Build create and edit forms

- [ ] Use Select for Customer and eligible optional Contact, FormInput for title/date/currency, FormTextarea for description, and FormNumericInput with numeric value plus locale/currency constraints for expected value.
- [ ] When Customer changes, reload eligible Contacts via generated client and clear an invalid prior choice with accessible explanation. Exclude status, deletion, tenant, and Legal Entity fields.
- [ ] Handle inline validation, first-error focus, pending/duplicate prevention, value preservation, typed forbidden/not-found/conflict/unavailable outcomes, and success refetch/Toast without false completion.

### 4. Add explicit Deal deletion

- [ ] Keep delete outside edit, require a danger confirmation Dialog naming the Deal and explaining that historical children remain, and preserve/restore focus correctly.
- [ ] Map stale conflict, forbidden, not-found, unavailable/retry, and success; after success remove ordinary selection/list row without implying Offer/Activity cascade.

### 5. Localize and test complete behavior

- [ ] Add English/Czech visible/accessibility copy, fixed status display labels, money/date/form issues, filter/empty/error/retry/delete/success strings.
- [ ] Add component/route tests for every required state, exact filter/URL/cursor behavior, dependent Contact options, localized numeric/date input, delete confirmation, pending/success/refetch, keyboard/focus, narrow layout, long content, read-only/deprecated modules, and absence of search/status edit controls.

### 6. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Test URL/view models, exact filter, money/date validation, dependent Contact options, typed errors,
forms/dialogs, status display-only, translations, accessibility, responsive semantics, and no-search.

### Integration Tests

Route tests mock generated Effect clients to prove loading/filter/pagination/detail, mutation
invalidation/refetch, conflict recovery, retry, selected-context behavior, and transport/decode errors.

### Edge Cases

- Customer changes after an optional Contact was selected.
- Selected Deal disappears or belongs to another Legal Entity.
- Money/date/currency input is invalid for locale.
- Long titles/descriptions render on a narrow viewport.
- Module becomes read-only while a form is open.

## Acceptance Criteria

- [ ] Users can paginate/filter/view/create/edit/delete Deals through generated clients in selected Legal Entity.
- [ ] Customer/eligible Contact and money/date fields work; status is never editable in ordinary forms.
- [ ] All required typed states, localization, accessibility, responsive/read-only behavior, and UI tests pass.
- [ ] No CRM search UI or behavior exists.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Deal component/route/view-model tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck Deal UI/client integration.
- `mise exec -- pnpm i18n:boundaries` — validate complete English/Czech copy.
- `mise exec -- pnpm api:check` — verify generated Effect clients only.
- `mise exec -- pnpm module-entrypoints:check` — verify the generated Deals page remains governed.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependency: ticket 9 must be complete.
- Figma is structural input from `Pre-Alpha Repo` only; UI-kit owns appearance.
- Exact Customer filtering is allowed; CRM search is forbidden. Ticket 12 owns status controls and ticket 14 owns Offer UI.
