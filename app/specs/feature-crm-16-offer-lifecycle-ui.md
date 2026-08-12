---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 16 Offer lifecycle UI

## Feature Description

Implement ticket 16, "Implement the Offer lifecycle UI," from `app/tickets.md`. Display localized
Offer status and expose only currently valid explicit next-state controls, including a clear
higher-revision requirement for Supersede, using only the generated `ChangeOfferStatus` Effect
client. Terminal Offers have no lifecycle controls; all typed states, confirmations, localization,
accessibility, responsive behavior, and tests are included without search.

## User Story

As a CRM sales user
I want to perform only valid Offer lifecycle transitions
So that I can send and resolve proposals without creating inconsistent states

## Problem Statement

Offer revision UI is lifecycle-read-only. Controls must reflect the backend graph, terminal states,
higher-revision eligibility, competing acceptance conflicts, read-only modules, and typed
unavailable failures without exposing status in ordinary forms or implying external sending.

## Solution Statement

Extend Offer view models/presentation with localized Badges and a dedicated transition control
whose options come from current status and higher-revision data. Invoke/refetch via generated
clients. Use Figma file `GWzuNz24M0GzeOgGtuylj1`, page `Pre-Alpha Repo`, only for general status
action/control/dialog placement—not business rules or visual styling.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative Offer transition UI and non-effects.
- `tickets.md` — corresponding ticket 16; blocked by tickets 14 and 15.
- `verticals/crm/src/offers/offer-revisions-panel.tsx` and `offer-view-model.ts` — Offer detail integration.
- `verticals/crm/src/routes/[lang]/deals/page.tsx` — Deal/Offer workspace.
- `verticals/crm/src/api/` — generated lifecycle/read Effect clients.
- `verticals/crm/locales/en/` and `verticals/crm/locales/cs/` — lifecycle copy.
- `docs/frontend/FRONTEND.md` and `docs/frontend/FIGMA.md` — UI and structural-design rules.
- `https://www.figma.com/design/GWzuNz24M0GzeOgGtuylj1/ERP?node-id=4-2&p=f&t=lootc1Zy6fQ1JzON-0` — `Pre-Alpha Repo` page only.

### New Files

- `verticals/crm/src/offers/offer-status-control.tsx` — plain valid-transition presentation.
- `verticals/crm/tests/unit/offer-lifecycle-ui.test.tsx` — state/confirmation/conflict tests.

## Implementation Plan

### Phase 1: Foundation

Map current status/higher-revision context to valid target options and complete typed mutation/read
states in plain view models.

### Phase 2: Core Implementation

Render Badges and dedicated transition/confirmation controls with correct terminal, Supersede,
pending, keyboard/focus, responsive, and read-only behavior. Forms remain status-free.

### Phase 3: Integration

Compose generated Effects, refetch after conflict/success, localize all copy, and test each graph
state, higher revision, concurrent acceptance, unavailable, no-search, and no-send implication.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Extend Offer lifecycle view models

- [ ] Map Draft to Sent/Withdrawn; Sent to Accepted/Rejected/Withdrawn and Superseded only when a higher active revision exists; map terminal statuses to no options.
- [ ] Model loading, empty/not-found Offer, validation, forbidden, conflict, unavailable/retry, pending, success, read-only, and refreshed state without leaking Effects/BFF errors to presentation.

### 2. Render localized status and valid controls

- [ ] Show status Badges in revision list/detail and render a dedicated accessible target control outside ordinary create/edit forms.
- [ ] Hide transition controls for terminal Offers; explain Supersede ineligibility and name/identify the higher revision when eligible; do not imply that Sent sends email or a document.
- [ ] Require clear confirmation for consequential targets, use loading/disabled semantics, prevent duplicates, and preserve focus/announcements/responsive Deal context.

### 3. Integrate typed outcomes and refresh

- [ ] Invoke generated lifecycle client with Offer ID/target/expected version; map validation, forbidden, not-found, semantic ineligibility, stale/current/acceptance conflict, unavailable/retry, transport/decode, and success distinctly.
- [ ] On conflict, refetch all relevant Deal revisions before showing updated allowed targets; never show false success. On success, refresh list/detail, restore focus, and announce committed status.
- [ ] Keep data readable but mutation unavailable with an accessible explanation for read-only/deprecated module states.

### 4. Localize and test

- [ ] Add all English/Czech status, target, confirmation, Supersede eligibility, no-external-send explanation, pending, error/retry, read-only, and success copy/accessibility labels.
- [ ] Add component/route tests for Draft/Sent/each terminal status, higher revision present/absent, loading, empty/not-found, validation, forbidden, semantic rejection, concurrent acceptance/conflict/refetch, unavailable/retry, success, pending duplicates, keyboard/focus, responsive/read-only behavior, status-form exclusion, no search, and no send implication.

### 5. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Table-test status-to-target mapping, Supersede eligibility, terminal presentation, typed errors,
confirmations, focus/keyboard, translations, responsive semantics, and form/search exclusions.

### Integration Tests

Feature/route tests mock generated lifecycle/read clients for expected-version calls, revision
refetch after acceptance/supersede conflicts, retry, success invalidation, and transport/decode errors.

### Edge Cases

- Higher revision is deleted or becomes unavailable during confirmation.
- Another revision is accepted first.
- Offer becomes terminal before submission.
- Module becomes read-only while interaction is open.

## Acceptance Criteria

- [ ] Offer revisions display localized statuses and only valid next-state controls.
- [ ] Terminal Offers have no controls and Supersede clearly requires a higher active revision.
- [ ] All required typed states, refresh behavior, translations, accessibility, responsive/read-only behavior, and UI tests pass.
- [ ] No CRM search or external-send behavior is implied or implemented.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run Offer lifecycle component/route tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — typecheck lifecycle UI/client integration.
- `mise exec -- pnpm i18n:boundaries` — validate Offer lifecycle translations.
- `mise exec -- pnpm api:check` — verify generated Effect client use.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 14 and 15 must both be complete.
- Figma is structural input from `Pre-Alpha Repo` only; UI-kit owns appearance.
- Sending, PDF/document generation, line items, products, automation, and search are non-goals.
