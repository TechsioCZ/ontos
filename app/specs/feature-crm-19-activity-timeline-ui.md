---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 19 Activity and timeline UI

## Feature Description

Implement ticket 19, "Implement the Activity and timeline UI," from `app/tickets.md`. Extend the
Customer workspace with a paginated chronological mixed timeline and create/edit/soft-delete
Activity interactions using only completed generated Activity/timeline Effect clients. Clearly
distinguish Activity, Deal, and Offer entries; explain that Activities record completed interactions
without sending/scheduling anything; cover all typed states, locales, accessibility, responsive
behavior, and tests; add no CRM search.

## User Story

As a CRM user
I want to record interactions and review one Customer relationship history
So that human and commercial context is visible in a coherent chronology

## Problem Statement

The Activity and timeline backends have no presentation. The UI must combine read-only lifecycle
facts with mutable Activity entries, preserve selected Customer/scope, handle safe deleted labels,
paginate deterministically, and never imply that an Email/Call/Meeting type performs an external action.

## Solution Statement

Add a timeline panel and Activity forms/dialogs to the Customer page using UI-kit semantic list,
Badge/StatusText, form, Select, Dialog, Button, and Toast components. Compose generated Effects in
feature code. Use Figma file `GWzuNz24M0GzeOgGtuylj1`, page `Pre-Alpha Repo`, only for general
timeline/list, form/dialog, and action placement—not requirements, appearance, styling, or branding.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Activity fields, timeline sources, states, and non-effects.
- `tickets.md` — corresponding ticket 19; blocked by tickets 4, 17, and 18.
- `verticals/crm/src/routes/[lang]/customers/page.tsx` and `page.data.ts` — Customer workspace integration.
- `verticals/crm/src/api/` — generated Activity Action/read and timeline Effect clients.
- `verticals/crm/locales/en/` and `verticals/crm/locales/cs/` — Activity/timeline copy.
- `docs/frontend/FRONTEND.md` and `docs/frontend/FIGMA.md` — typed presentation and structural-design rules.
- `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=4-2&p=f&t=lootc1Zy6fQ1JzON-0` — `Pre-Alpha Repo` page only.

### New Files

- `verticals/crm/src/activities/activity-view-model.ts` — forms/mutation states.
- `verticals/crm/src/activities/activity-dialogs.tsx` — Activity create/edit/delete presentation.
- `verticals/crm/src/timeline/customer-timeline-view-model.ts` — mixed entry/pagination states.
- `verticals/crm/src/timeline/customer-timeline-panel.tsx` — semantic mixed timeline presentation.
- `verticals/crm/tests/unit/activity-timeline-ui.test.tsx` — component/accessibility/state tests.
- `verticals/crm/tests/unit/routes/customers/timeline-integration.test.tsx` — client/URL/pagination tests.

## Implementation Plan

### Phase 1: Foundation

Extend Customer URL/view models with timeline cursor, mixed entry discriminants, Activity forms, safe
labels, capabilities, and exhaustive generated-client state mappings.

### Phase 2: Core Implementation

Render chronological entries and Activity create/edit/delete with UI-kit components. Lifecycle
entries are read-only; only active Activities expose edit/delete; external-action non-effects are explicit.

### Phase 3: Integration

Compose generated Effects, refetch timeline after Activity mutations, retain Customer context,
localize all copy, and test pagination/order/errors/focus/responsive/read-only/no-search behavior.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define mixed timeline and Activity UI states

- [ ] Add opaque timeline cursor to selected Customer URL state and map loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, success, read-only, and pagination states from generated clients.
- [ ] Map Activity, Deal status, Offer created, and Offer status entries to plain localized view models with stable keys, occurred time, safe deleted labels, distinct semantic labels/icons/Badges, and Activity-only capabilities.
- [ ] Keep Effects, BFF/domain errors, route/query infrastructure, and mutation logic outside presentation.

### 2. Render the deterministic timeline

- [ ] Render a semantic chronological list/section with accessible heading/entry labels, clear empty state, backend cursor pagination/load-more, stable order, and no client re-sorting that changes contract order.
- [ ] Distinguish entry types without color alone, show safe historical labels, wrap long summaries on narrow screens, preserve Customer context/focus, and expose retry without duplicating already loaded entries.
- [ ] Do not add timeline or Activity search, free-text filtering, search query parameters/providers, or keyboard search shortcuts.

### 3. Implement Activity create and edit

- [ ] Use Select for fixed type and eligible optional Contact/Deal, FormInput for subject/occurrence time, and FormTextarea for details. Customer is fixed by context; trusted scope/deletion are absent.
- [ ] Clearly state in English/Czech that Activity types record completed interactions and do not send email, place calls, or schedule meetings.
- [ ] Handle inline validation/first-error focus, dependent optional links, pending/duplicate prevention, value preservation, forbidden/not-found/conflict/unavailable, and committed success/refetch/Toast through generated clients.

### 4. Implement explicit Activity deletion

- [ ] Keep delete separate with a danger confirmation Dialog and pending/focus semantics; lifecycle entries and deleted historical labels expose no delete action.
- [ ] Map stale conflict, forbidden, not-found, unavailable/retry, and success. After success, refresh timeline from the first/current-safe cursor so no duplicate/gap/false entry remains.

### 5. Localize and test complete behavior

- [ ] Add English/Czech visible/accessibility copy for all types/entry discriminants, fields, historical labels, non-effect explanation, loading/empty/errors/retry/pagination/delete/success/read-only states.
- [ ] Add component/route tests for empty/mixed/tie order/page boundaries, loading, validation, forbidden, not-found, conflict, unavailable/retry, success, safe deleted labels, Activity CRUD, dependent links, non-effect copy, pending duplicates, pagination/URL, keyboard/focus, narrow/long content, read-only/deprecated state, lifecycle read-only behavior, and no search.

### 6. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Test mixed-entry view mapping, stable pagination append, safe labels, Activity forms/capabilities,
typed errors, non-effect copy, dialogs/focus, translations, responsive semantics, and no-search.

### Integration Tests

Route tests mock generated timeline/Activity clients for cursor pages, mixed order, Activity mutation
refetch/conflict/retry, selected Customer context, typed decode/transport failures, and success.

### Edge Cases

- Empty or only one timeline source.
- Equal occurrence timestamps across sources/page boundary.
- Linked Contact/Deal/Offer is deleted.
- Optional Contact/Deal becomes ineligible while form is open.
- Module becomes read-only or data unavailable during mutation.

## Acceptance Criteria

- [ ] Customer details show a paginated mixed chronological timeline with clear empty/type distinctions.
- [ ] Users can create/edit/delete Activities through generated clients; lifecycle entries remain read-only.
- [ ] UI clearly states Activities do not perform external communication/scheduling.
- [ ] All typed states, safe labels, pagination, localization, accessibility, responsive/read-only behavior, and tests pass.
- [ ] No CRM search UI or behavior exists.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Activity/timeline component/route tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck Activity/timeline integration.
- `mise exec -- pnpm i18n:boundaries` — validate English/Czech copy.
- `mise exec -- pnpm api:check` — verify generated Effect clients only.
- `mise exec -- pnpm module-entrypoints:check` — verify Customer page/timeline provider governance.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 4, 17, and 18 must all be complete.
- Figma is structural input from `Pre-Alpha Repo` only; UI-kit owns appearance.
- External communication/scheduling, timeline audit rows, and CRM search are non-goals.
