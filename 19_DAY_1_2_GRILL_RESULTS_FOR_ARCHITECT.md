# Day 1/2 Grill Results For Project Architect

Date: 2026-06-08

This document summarizes the `/grill-with-docs` decisions made before implementing Day 1 and Day 2 from `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`. The goal was to remove ambiguity before creating the fresh `mvp/` UltraModern.js project.

## Scope Confirmed

Implement Day 1 and Day 2 together as one batch.

Day 1 concerns shell setup and real MicroVertical composition. Day 2 concerns public manifests, private runtime registrations, installed registry, placeholder public descriptors, and boundary enforcement.

No real ERP product behavior should be implemented in this batch.

## Grilling Results

### 1. Where should the fresh app live?

Question: Should the new app live under `app/`, in the root, or elsewhere?

Decision: Create a top-level `mvp/` folder and use it as the UltraModern.js project root.

Changes: This decision is captured in the handoff-oriented implementation language; no app folder has been created yet.

### 2. Which second MVP MicroVertical key should be used?

Question: Should the second dummy MicroVertical remain `accounting.core`, even though other docs mention `accounting.office` and `accounting.export`?

Decision: Use `accounting.core` for the MVP only. Treat it as a placeholder key, not a final V1 accounting boundary.

Changes: Day 1/2 descriptor examples and handoff checklist use `accounting.core`.

### 3. Should the MVP use SuperApp workspace topology?

Question: Should the app be the default single UltraModern app or a SuperApp workspace with real MicroVerticals?

Decision: Use the new UltraModern.js default SuperApp workspace model once confirmed by the user. `--ultramodern-workspace` must not be used because the user says the flag has been removed and workspace mode is now default.

Changes: No command was hardcoded into canonical docs. The batch evidence section requires recording the exact create package version and scaffold commands actually used.

### 4. Should `property.registry` and `accounting.core` be real MicroVerticals?

Question: Should they be real UltraModern.js MicroVerticals or shell-local placeholders?

Decision: They must be real MicroVerticals.

Changes: The handoff now treats them as mounted MicroVerticals with owned route/page/component areas.

### 5. How should Day 1 and Day 2 be sequenced?

Question: Should Day 1 hard-code module lists and then Day 2 overwrite them?

Decision: Implement Day 1 and Day 2 in one batch. Anything Day 2 would replace should be implemented directly using the Day 2 shape.

Changes: The handoff now includes a Day 1/2 batch evidence checklist.

### 6. How should Shell discover modules?

Question: Should Shell discover modules from public manifests or a private registry?

Decision: Shell/Core discover runnable installed modules from the private installed registry. Each registry entry carries the public manifest plus private runtime hooks.

Changes:

- Added `Vertical Runtime Registration` and `Installed Vertical Registry` to `CONTEXT.md`.
- Added a `Runtime Registration` section to `14_ONTOS_MODULE_MANIFEST.md`.
- Updated `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md` to use these terms.

### 7. What should the public/private file names be?

Question: Should files be named `manifest.ts` and `implementation.ts`, `ontos.module.ts`, or something else?

Decision:

```text
verticals/[vertical-folder]/vertical.manifest.ts
verticals/[vertical-folder]/vertical.registration.ts
apps/shell/src/verticals/installed.registry.ts
```

`vertical.manifest.ts` is the public contract. `vertical.registration.ts` is private runtime registration. `installed.registry.ts` is Shell/Core's installed allowlist.

Changes: `14_ONTOS_MODULE_MANIFEST.md` documents this naming convention and removed the old open question about where manifests should live.

### 8. What is the identifier vs folder naming rule?

Question: Should dotted names be used for folders too?

Decision: Use dotted names for semantic/runtime identifiers and hyphenated names for filesystem folders.

Examples:

```text
module id: property.registry
action key: property.registry.createUnit
folder: verticals/property-registry
```

Generator commands should use hyphenated names such as `property-registry` and `accounting-core`. Manifest ids and runtime keys stay dotted.

Changes: `14_ONTOS_MODULE_MANIFEST.md` and the Day 1 handoff now document this mapping.

### 9. Should Actions be first-class manifest surface?

Question: Should Actions be described only through public API clients, or first-class public manifest descriptors?

Decision: Actions are first-class public descriptors in the manifest. Handlers stay private.

Changes:

- Added `Action Descriptor` to `CONTEXT.md`.
- Added an `Actions` section to `14_ONTOS_MODULE_MANIFEST.md`.
- Updated Day 2 handoff to require placeholder Action descriptors.

### 10. Where should Action descriptors and handlers live?

Question: Should `defineVerticalAction(...)` live directly in `vertical.manifest.ts`?

Decision: No. Action descriptors live in per-action files and are imported into the manifest.

Recommended shape:

```text
verticals/property-registry/
  vertical.manifest.ts
  vertical.registration.ts
  src/actions/
    create-unit.action.ts
    create-unit.handler.ts
```

Use Effect Schema-backed runtime values for request/response schemas. Handlers should return Effect values where practical and receive dependencies through Effect Context/Layer.

Changes: `14_ONTOS_MODULE_MANIFEST.md` now documents this pattern.

### 11. Which placeholder Actions are required for Day 1/2?

Question: Should `actions: []` be allowed until Day 3?

Decision: No. Include placeholder descriptors now to prove the manifest/registration shape.

Required placeholder Action descriptors:

- `property.registry.createUnit`
- `accounting.core.createDraftEntry`

Handlers may be stubbed or explicitly not implemented. No real ERP behavior should be implemented.

Changes: Added to `14_ONTOS_MODULE_MANIFEST.md` and the Day 2 checklist in `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`.

### 12. Which public descriptor surfaces should Day 2 expose?

Question: Should the MVP expose only minimal/empty arrays, or enough descriptors to verify the manifest thesis?

Decision: Expose enough descriptor surface to verify public manifests across both MVP MicroVerticals.

Required placeholder descriptors:

Resources:

- `property.unit`
- `accounting.draft_entry`

Public components:

- `PropertyUnitCard`
- `AccountingDraftEntryCard`

Actions:

- `property.registry.createUnit`
- `accounting.core.createDraftEntry`

Search:

- `property.unit.search_result`
- `accounting.draft_entry.search_result`

Reports:

- `property.unit.inventory`
- `accounting.draft_entry.summary`

Changes: Added these concrete descriptor keys to `14_ONTOS_MODULE_MANIFEST.md` and the Day 2 handoff.

### 13. Who owns routes and pages?

Question: Should Shell own all routes and render vertical components, or should MicroVerticals own route subtrees?

Decision: Each MicroVertical owns its route subtree, pages, and components. Shell composes registered route/nav contributions, applies shared layout, and filters visibility through module state.

Changes: `14_ONTOS_MODULE_MANIFEST.md` now states this explicitly in the runtime registration section.

### 14. How should module activation state work in Day 1/2?

Question: Should module activation be real runtime state or a static stub?

Decision: Day 1/2 should use a fixture shaped like `CORE_TENANT_MODULE_STATES`. Both MVP modules are `active` for the demo tenant.

Changes: Added this to `14_ONTOS_MODULE_MANIFEST.md` and Day 2 tasks/acceptance in the handoff.

### 15. Should `inactive` and `deprecated` be real persisted states?

Question: The ERD omitted `inactive` and `deprecated`, while manifest/handoff mentioned them. Which is correct?

Decision: Add `inactive` and `deprecated` to the persisted module state enum.

Final enum:

```text
inactive | active | read_only | suspended | quarantined | deprecated | archived
```

Changes:

- Updated `diagrams/core-db-resource-ref-v0.mmd`.
- Updated `diagrams/core-db-resource-ref-v0.html`.
- Updated `diagrams/module-lifecycle.md`.
- Updated `05_MICROVERTICALS.md`.
- Updated ADR-0008.

### 16. Which states appear in normal Shell navigation?

Question: Should inactive modules appear in navigation?

Decision: Normal Shell navigation shows:

- `active`
- `read_only`
- `deprecated`

Normal Shell navigation hides:

- `inactive`
- `suspended`
- `quarantined`
- `archived`

Non-active visible states should have visible state indicators.

Changes: Added to `05_MICROVERTICALS.md`, `14_ONTOS_MODULE_MANIFEST.md`, and Day 2 acceptance.

### 17. How should public/private imports be enforced?

Question: What should stop one MicroVertical from importing another's internals?

Decision: Use one stable command: `pnpm check:boundaries`.

Rules:

- Shell/Core may import `vertical.registration.ts`.
- Ordinary MicroVertical consumers must not import `vertical.registration.ts`.
- No consumer should import another MicroVertical's private handlers, private routes, private tables, private migrations, fixtures, or tests.
- Cross-MicroVertical imports should go through public manifest values, Action descriptors, API clients, public component values, and public resource/event/search/report descriptors.

If UltraModern generates a boundary checker, `check:boundaries` should call/wrap it and add OntOS-specific rules. If not, `check:boundaries` can be a small import-scanning script. `pnpm check` must run `pnpm check:boundaries`.

Changes: Added to `14_ONTOS_MODULE_MANIFEST.md` and the Day 2 handoff.

### 18. What should visible boundary markers show?

Question: What should UI evidence show to prove Shell is composing real MicroVertical surfaces?

Decision: Each MicroVertical route should visibly show:

- semantic module id
- filesystem folder name
- tenant module state
- rendered-from/owned-by MicroVertical marker

Changes: Added to Day 1 acceptance and `14_ONTOS_MODULE_MANIFEST.md`.

### 19. What counts as Day 1/2 completion evidence?

Question: Since Day 1 and Day 2 are implemented together, what evidence is required?

Decision: Keep the original Day 1 and Day 2 acceptance lists, and add a combined batch evidence checklist.

Required batch evidence:

- exact UltraModern.js create package version and scaffold commands used
- `pnpm check` passing, including `pnpm check:boundaries`
- local app run command and URL
- screenshots showing Shell navigation and both MicroVertical boundary markers
- changed-file summary calling out manifests, registrations, installed registry, and boundary-check wiring
- notes on scaffold limitations or places where generated UltraModern behavior shaped the implementation

Changes: Added `Day 1/2 Batch Evidence` to `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`.

## Documents Changed During Grilling

- `CONTEXT.md`
- `05_MICROVERTICALS.md`
- `14_ONTOS_MODULE_MANIFEST.md`
- `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`
- `adr/0008-module-activation-state-model.md`
- `diagrams/core-db-resource-ref-v0.mmd`
- `diagrams/core-db-resource-ref-v0.html`
- `diagrams/module-lifecycle.md`

## Implementation-Ready Summary

The next implementation should create `mvp/` with the current UltraModern.js create package after confirming the new default SuperApp workspace behavior. It should add two real MicroVerticals using hyphenated folder names:

```text
property-registry
accounting-core
```

Their public runtime ids remain:

```text
property.registry
accounting.core
```

The batch is accepted only when the shell runs locally, both MicroVertical routes render with visible boundaries, the manifest/registration split is explicit, the placeholder public descriptor surfaces exist, both modules are active for the demo tenant, and `pnpm check` includes the boundary check.
