---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 08 Primary Contact UI

## Feature Description

Implement ticket 8, "Implement the primary Contact UI," from `app/tickets.md`. Show the current
primary Contact in Customer/Contact views and provide explicit set, replace, and clear controls
separate from Contact editing. Use only the completed generated `ChangeCustomerPrimaryContact`
Effect client and cover every typed state, concurrency recovery, localization, accessibility, and
responsive behavior without CRM search.

## User Story

As a CRM user
I want to see and explicitly change the primary Contact
So that preferred-contact status is clear and never changed accidentally through editing

## Problem Statement

The atomic backend exists but users cannot invoke or understand it. The UI must keep primary status
out of ordinary forms, avoid false success during concurrent changes, and preserve or refresh state
safely after conflicts or unavailable responses.

## Solution Statement

Add a localized primary indicator and explicit UI-kit actions in the Customer Contact workspace.
Use a confirmation/selection interaction driven by current active Contact view models and the
generated Action client. Use Figma file `GWzuNz24M0GzeOgGtuylj1`, page `Pre-Alpha Repo`, only for
general detail/action/dialog placement, never requirements or styling.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative primary-contact UI separation and outcomes.
- `tickets.md` — corresponding ticket 8; blocked by tickets 6 and 7.
- `verticals/crm/src/routes/[lang]/customers/page.tsx` — Customer/Contact workspace integration.
- `verticals/crm/src/contacts/contact-panel.tsx` — ordinary Contact presentation to extend without adding edit fields.
- `verticals/crm/src/api/` — generated primary-contact Action Effect client.
- `verticals/crm/locales/en/` and `verticals/crm/locales/cs/` — localized visible/accessibility copy.
- `docs/frontend/FRONTEND.md` and `docs/frontend/FIGMA.md` — presentation and structural-design rules.
- `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=4-2&p=f&t=lootc1Zy6fQ1JzON-0` — `Pre-Alpha Repo` page only.

### New Files

- `verticals/crm/src/contacts/primary-contact-control.tsx` — plain UI-kit presentation for indicator/set/replace/clear.
- `verticals/crm/tests/unit/primary-contact-ui.test.tsx` — state, focus, confirmation, and concurrency tests.

## Implementation Plan

### Phase 1: Foundation

Extend Contact view models with current-primary identity, eligible active options, expected versions,
and explicit mutation states mapped from the generated client.

### Phase 2: Core Implementation

Render indicators and separate set/replace/clear controls with confirmation and pending semantics;
ordinary Contact forms remain unchanged.

### Phase 3: Integration

Compose the generated Effect Action in route/feature code, refetch after completion/conflict,
preserve safe selection/input, localize all copy, and test keyboard/focus/responsive/error behavior.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define explicit primary-contact UI states

- [ ] Extend plain Customer/Contact view models with current primary, eligible active Contacts, expected versions, pending target, confirmation mode, conflict refresh, forbidden, not-found, unavailable/retry, and success states.
- [ ] Keep Effects, BFF errors, routing, and query infrastructure in feature integration; presentation receives semantic callbacks such as set/replace/clear/retry.

### 2. Show status without polluting ordinary edit

- [ ] Add localized current-primary indicators to Customer details and the matching Contact row/detail using an appropriate UI-kit Badge/StatusText pattern.
- [ ] Confirm ordinary Contact create/edit forms contain no primary checkbox, select, hidden field, or mutation callback and add regression tests for that absence.

### 3. Implement set, replace, and clear controls

- [ ] Provide explicit keyboard-accessible actions and an eligible Contact selection/confirmation interaction. Set/replace names both current and proposed Contact; clear explicitly explains the result.
- [ ] Use UI-kit pending/loading/disabled semantics, prevent duplicate requests, return focus after cancel/success, and announce state changes without claiming success before the typed Action completes.
- [ ] Do not add a search box to Contact selection; use the already bounded/paginated active Contact data and clear empty/unavailable states.

### 4. Handle all generated Action outcomes

- [ ] Map validation, forbidden, not-found, stale/competing conflict, unavailable/retry, transport/decode failure, and success distinctly. Loading/empty Contact states remain explicit around the control.
- [ ] On conflict, refetch current primary/options and either preserve a still-valid proposed Contact for confirmation or explain why it disappeared; never overwrite the refreshed state or show false success.
- [ ] On success, refresh Customer/Contact models, update indicators once, close/restore focus, and show localized feedback.

### 5. Localize and test

- [ ] Add all English/Czech labels, confirmations, accessible names, pending, conflict, unavailable, empty, and success copy.
- [ ] Add component/route tests for no-primary, current-primary, set, replace, clear, loading, empty eligible list, validation, forbidden, not-found, conflict refresh/preservation, unavailable/retry, success, duplicate-submit prevention, keyboard/focus, narrow layout, read-only/deprecated state, and absence of primary edit/search controls.

### 6. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Test view-model/error mapping, indicators, selection/confirmation states, ordinary-form exclusion,
focus/keyboard, translations, and responsive semantics.

### Integration Tests

Route/feature tests mock the generated primary Action/read clients to prove expected-version input,
conflict refetch, selection preservation, retry, success invalidation, and typed failures.

### Edge Cases

- Customer has no Contacts or no current primary.
- Proposed Contact is deleted during confirmation.
- Another user replaces/clears the primary first.
- Current primary is the selected target.
- Module becomes read-only while dialog is open.

## Acceptance Criteria

- [ ] Customer/Contact views identify the primary without exposing primary in ordinary edit.
- [ ] Explicit controls safely set, replace, and clear through the generated Action client.
- [ ] Loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, success, localization, accessibility, responsive, and tests pass.
- [ ] No CRM search UI or behavior exists.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run primary-contact UI and route tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck primary Contact integration.
- `mise exec -- pnpm i18n:boundaries` — verify English/Czech copy.
- `mise exec -- pnpm api:check` — verify generated Effect client use.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 6 and 7 must both be complete.
- Figma is illustrative structural input from `Pre-Alpha Repo` only; UI-kit owns appearance.
- Contact reassignment, automatic primary choice, and CRM search are non-goals.
