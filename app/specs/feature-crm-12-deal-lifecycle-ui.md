---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 12 Deal lifecycle UI

## Feature Description

Implement ticket 12, "Implement the Deal lifecycle UI," from `app/tickets.md`. Add localized Deal
status presentation and an explicit lifecycle interaction that permits every agreed target status,
including reopening Won/Lost Deals, using only the generated `ChangeDealStatus` Effect client.
Ordinary Deal forms remain status-free; all typed loading/empty/error/success states, accessibility,
responsive behavior, English/Czech copy, and tests are included without search.

## User Story

As a CRM sales user
I want to understand and explicitly change or reopen Deal status
So that lifecycle changes are deliberate, current, and auditable

## Problem Statement

Deal status is currently display-only. The UI must expose all valid targets, explain reopening,
handle stale concurrent transitions safely, never claim false success, and keep lifecycle mutation
separate from ordinary Deal editing.

## Solution Statement

Extend Deal list/detail view models with localized status Badges and a dedicated UI-kit Select/menu
plus confirmation/action state. Compose the generated lifecycle client in feature code and refetch
after success/conflict. Use Figma file `GWzuNz24M0GzeOgGtuylj1`, page `Pre-Alpha Repo`, only for
general detail action/control/dialog placement, never requirements or visual styling.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative lifecycle statuses, transitions, and UI states.
- `tickets.md` — corresponding ticket 12; blocked by tickets 10 and 11.
- `verticals/crm/src/routes/[lang]/deals/page.tsx` — Deal workspace integration.
- `verticals/crm/src/deals/deal-workspace.tsx` and `deal-view-model.ts` — status presentation/interaction contracts.
- `verticals/crm/src/api/` — generated ChangeDealStatus Effect client.
- `verticals/crm/locales/en/` and `verticals/crm/locales/cs/` — lifecycle copy.
- `docs/frontend/FRONTEND.md` and `docs/frontend/FIGMA.md` — typed UI and structural-design rules.
- `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=4-2&p=f&t=lootc1Zy6fQ1JzON-0` — `Pre-Alpha Repo` page only.

### New Files

- `verticals/crm/src/deals/deal-status-control.tsx` — plain lifecycle presentation.
- `verticals/crm/tests/unit/deal-lifecycle-ui.test.tsx` — status/control/error/focus tests.

## Implementation Plan

### Phase 1: Foundation

Define localized status view models, all target options except current, expected-version input, and
exhaustive generated-client mutation states.

### Phase 2: Core Implementation

Render Badges and dedicated change/reopen controls with UI-kit semantics, confirmation, pending,
keyboard/focus, and responsive behavior. Ordinary forms remain unchanged.

### Phase 3: Integration

Invoke/refetch through generated Effects, recover from conflicts, add all English/Czech copy, and
test every status, typed outcome, read-only state, and no-search/status-edit regression.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Extend lifecycle view models

- [ ] Map every fixed status to localized label/Badge semantics and generate every other status as a target; explicitly label reopening when current status is Won/Lost.
- [ ] Model loading, empty/not-found Deal, validation, forbidden, stale conflict, unavailable/retry, pending, success, and read-only/deprecated states without passing Effects/BFF errors to presentation.

### 2. Build the dedicated lifecycle control

- [ ] Show localized status Badges in Deal list/detail and a separate accessible status control in detail; do not add status to create/edit forms or use free-text input.
- [ ] Permit all agreed target statuses, confirm potentially consequential transitions/reopening with clear current/target copy, prevent duplicate submissions, and keep focus/announcements correct.
- [ ] Use responsive UI-kit composition and preserve list/detail URL context while the interaction is open.

### 3. Integrate typed Action outcomes

- [ ] Invoke the generated client with Deal ID, target, and expected version; map validation, forbidden, not-found, stale/no-op conflict, unavailable/retry, transport/decode failure, and success distinctly.
- [ ] On conflict, refetch and show current status before allowing another choice; on success, refresh list/detail, close/restore focus, and announce only the committed status.
- [ ] Hide/disable mutation with accessible explanation in read-only/deprecated states while keeping status readable.

### 4. Localize and test

- [ ] Add English/Czech status, target, reopening, confirmation, pending, conflict, retry, read-only, and success copy including accessible labels.
- [ ] Add component/route tests for all six statuses/target sets, Won/Lost reopening, loading, empty/not-found, validation, forbidden, conflict/refetch, unavailable/retry, success, pending duplicate prevention, keyboard/focus, responsive layout, read-only/deprecated behavior, ordinary-form status exclusion, and absence of search.

### 5. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Table-test localized status/target view models, Badge/control states, confirmation, error mapping,
focus/keyboard, translations, responsive semantics, and status-form/search exclusions.

### Integration Tests

Feature/route tests mock the generated lifecycle/read clients for expected-version submission,
conflict refetch, success invalidation, retry, typed decode/transport failures, and URL preservation.

### Edge Cases

- Won/Lost Deal reopens to each other status.
- Another user changes status while confirmation is open.
- Current status becomes the chosen target before submission.
- Deal disappears or module becomes read-only.

## Acceptance Criteria

- [ ] Localized status Badges and dedicated controls expose every distinct target and reopening.
- [ ] Ordinary Deal forms cannot change status.
- [ ] All required typed states, refetch behavior, localization, accessibility, responsive/read-only behavior, and UI tests pass.
- [ ] No CRM search UI or behavior exists.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Deal lifecycle component/route tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck lifecycle UI/client integration.
- `mise exec -- pnpm i18n:boundaries` — validate lifecycle translations.
- `mise exec -- pnpm api:check` — verify generated Effect client use.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 10 and 11 must both be complete.
- Figma is structural input from `Pre-Alpha Repo` only; UI-kit owns appearance.
- No configurable pipeline, status search/filter expansion, or automation belongs here.
