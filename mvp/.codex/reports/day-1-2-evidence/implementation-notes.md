# Day 1/2 MVP Evidence

## Scaffold

- Requested bootstrap command: `pnpm dlx @bleedingdev/modern-js-create mvp`
- Requested command result in this environment: resolved local pnpm link `@bleedingdev/modern-js-create@3.2.0-ultramodern.112` and failed because `@modern-js/i18n-utils` was missing from that dlx sandbox.
- Registry-confirmed current create package: `@bleedingdev/modern-js-create@3.2.0-ultramodern.119`
- Successful bootstrap command: `pnpm dlx @bleedingdev/modern-js-create@3.2.0-ultramodern.119 mvp`
- Generated workspace: UltraModern SuperApp with shell at `apps/shell-super-app`, shared packages at `packages/*`, and vertical workspace glob `verticals/*`.

## Verification

- `pnpm install` completed with pnpm `11.5.2`.
- `pnpm check` passed.
- `pnpm check` includes `pnpm check:boundaries`.
- `pnpm check:boundaries` runs the generated UltraModern i18n/source boundary guard and OntOS registration/private-import checks.
- Local run command: `ULTRAMODERN_ZEPHYR=false pnpm dev`
- Local URL: `http://localhost:3020/`
- Browser-verified routes:
  - `http://localhost:3020/en`
  - `http://localhost:3020/en/property-registry`
  - `http://localhost:3020/en/accounting-core`

## Screenshots

- `shell-home.png`
- `property-registry.png`
- `accounting-core.png`

## Changed Surface

- Public manifests:
  - `verticals/property-registry/vertical.manifest.ts`
  - `verticals/accounting-core/vertical.manifest.ts`
- Private Vertical Runtime Registrations:
  - `verticals/property-registry/vertical.registration.ts`
  - `verticals/accounting-core/vertical.registration.ts`
- Action descriptors:
  - `verticals/property-registry/src/actions/create-unit.action.ts`
  - `verticals/accounting-core/src/actions/create-draft-entry.action.ts`
- Stub handlers:
  - `verticals/property-registry/src/actions/create-unit.handler.ts`
  - `verticals/accounting-core/src/actions/create-draft-entry.handler.ts`
- Shell/Core registry and discovery:
  - `apps/shell-super-app/src/verticals/installed.registry.ts`
  - `apps/shell-super-app/src/verticals/module-discovery.ts`
  - `apps/shell-super-app/src/verticals/route-model.ts`
- Shell navigation and route composition:
  - `apps/shell-super-app/src/routes/vertical-module-navigation.tsx`
  - `apps/shell-super-app/src/routes/shell-frame.tsx`
  - `apps/shell-super-app/src/routes/[lang]/property-registry/page.tsx`
  - `apps/shell-super-app/src/routes/[lang]/accounting-core/page.tsx`
- MicroVertical-owned page components:
  - `verticals/property-registry/src/pages/property-registry-page.tsx`
  - `verticals/accounting-core/src/pages/accounting-core-page.tsx`
- Boundary check wiring:
  - `scripts/check-ontos-boundaries.mjs`
  - `package.json`
- Acceptance tests:
  - `tests/day-1-2.acceptance.test.mjs`

## Scaffold Notes

- The generated i18n plugin requires localized URL entries for every route; the MVP routes use identical `en` and `cs` paths for now.
- Starting `pnpm dev` without `ULTRAMODERN_ZEPHYR=false` prompts for Zephyr Cloud authentication. Local MVP verification uses Zephyr disabled.
- The shell package must keep the generated package shape without `"type": "module"`; adding it breaks the current Module Federation Modern.js plugin because it assumes `__filename` while loading config.
- Node's acceptance test runner prints a module-type warning for shell `.ts` imports because the shell package intentionally remains non-ESM for the generated dev runtime.
