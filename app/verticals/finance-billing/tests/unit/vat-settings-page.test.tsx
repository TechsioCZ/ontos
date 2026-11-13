// @rstest-environment happy-dom
// The DPH page offers a VAT change only when Tax says the signed-in person may make it. A read-only accountant sees the
// regime with its history and the rates with their plans, and no control that would change them; an owner sees and
// can use every one. Tax itself still refuses a change from a person without the right (tax-vat-settings-postgres
// proves that refusal on the server). Only Tax's reads, the i18n runtime and the route head are replaced.
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { DateTime, Effect, Option } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { constVoid } from 'effect/Function';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { VatChangeRights } from '../../src/routes/[lang]/finance/dph/tax-access.ts';
import { VatPage } from '../../src/routes/[lang]/finance/dph/page.tsx';
import { gatewayRefusalState, vatSettingsData } from '../../src/routes/[lang]/finance/dph/vat-settings-data.ts';
import { financeBrowserRuntime } from '../../src/runtime/browser.ts';
import { pinDocumentNavigationModules } from '@app/shared-contracts';

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const { rights, taxState } = rstest.hoisted(() => ({
  rights: { current: { createRevision: false, createRule: false, declareRegime: false, endRevision: false } },
  /** What Tax (through the Shell) answers for the company. */
  taxState: { current: 'declared' },
}));

const ruleRef = {
  moduleId: 'commerce.tax',
  resourceId: 'rule-standard',
  resourceType: 'commerce.tax.tax-rule',
  tenantId: TENANT,
};
const revisionRef = (id: string) => ({
  moduleId: 'commerce.tax',
  resourceId: id,
  resourceType: 'commerce.tax.tax-rule-revision',
  tenantId: TENANT,
});
const at = (iso: string) => DateTime.makeUnsafe(iso);

rstest.mock('../../src/routes/[lang]/finance/dph/tax-access.ts', () => ({
  createClassificationRule: () => Effect.succeed('saved'),
  createRateRevision: () => Effect.succeed('saved'),
  declareRegime: () => Effect.succeed('saved'),
  endRateRevision: () => Effect.succeed('saved'),
  // The standard rate has a rule (21 % since 2024 and 23 % planned for 2099); the reduced one has none yet.
  readApplicableRule: (code: string) =>
    Effect.succeed({
      applicable: code === 'cz.vat.standard' ? [{ taxRuleRef: ruleRef }] : [],
      outcome: 'SELECTED',
    }),
  readRegimeAt: () =>
    // The Shell's own refusal when Tax is not installed for the tenant.
    taxState.current === 'notInstalled'
      ? Effect.fail({
          _tag: 'GatewayForbiddenProblem',
          detail: 'The module the call is for is not installed for the tenant.',
          status: 403,
          title: 'Module not installed',
          type: 'https://ontos.dev/problems/gateway-module-not-installed',
        })
      : Effect.succeed({
          headRevision: taxState.current === 'declared' ? 1 : 0,
          selection:
            taxState.current === 'declared' ? { _tag: 'DECLARED', regime: 'VAT_PAYER' } : { _tag: 'NOT_DECLARED' },
        }),
  readRegimeHistory: () =>
    Effect.sync(() => ({
      changeRights: rights.current,
      completeness: { rowCount: 1, setFingerprint: '0'.repeat(64) },
      revisions: [{ effectiveFrom: at('2023-12-31T23:00:00Z'), regime: 'VAT_PAYER', revision: 1 }],
    })),
  readRuleHistory: () =>
    Effect.succeed({
      basisFingerprint: '1'.repeat(64),
      corrections: [],
      revisions: [
        {
          effectiveFrom: at('2023-12-31T23:00:00Z'),
          effectiveTo: Option.some(at('2098-12-31T23:00:00Z')),
          endFact: Option.none(),
          ratePercent: '21',
          taxRuleRevisionRef: revisionRef('revision-21'),
        },
        {
          effectiveFrom: at('2098-12-31T23:00:00Z'),
          effectiveTo: Option.none(),
          endFact: Option.none(),
          ratePercent: '23',
          taxRuleRevisionRef: revisionRef('revision-23'),
        },
      ],
      taxRuleRef: ruleRef,
    }),
}));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const ns = 'finance-billing.vatSettings';
const context: ModulePageProps['context'] = { legalEntityId: 'company-a', principalId: 'person-a', tenantId: TENANT };
/** Lets running reads take a step, then flushes React's updates. */
const settle: Effect.Effect<void> = Effect.promise(() => financeBrowserRuntime.runPromise(Effect.yieldNow)).pipe(
  Effect.andThen(
    Effect.sync(() => {
      act(constVoid);
    }),
  ),
);
/** Runs `step` inside React's act, then lets what it started settle. */
const acted = (step: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    act(() => {
      step();
    });
  }).pipe(Effect.andThen(settle));
/** Lets the page work until `condition` holds; fails the test when it never does. */
const waitUntil = (condition: () => boolean, attempt = 0): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (condition() || attempt >= 200) {
      return Effect.sync(() => {
        expect(condition()).toBe(true);
      });
    }
    return settle.pipe(Effect.andThen(waitUntil(condition, attempt + 1)));
  });
const roots: { readonly container: HTMLElement; readonly root: Root }[] = [];
const render = () =>
  acted(() => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ container, root });
    root.render(<VatPage context={context} />);
  });
const text = () => document.body.textContent ?? '';
const buttons = () => [...document.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
const editing = [`${ns}.regimeChange`, `${ns}.plan`, `${ns}.withdraw`, `${ns}.firstRate`];

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  taxState.current = 'declared';
  // As on stage: the Shell pins the navigation of the person's company, and Tax has no navigation entry of its own.
  pinDocumentNavigationModules(['finance.billing', 'demo.merchandise', 'sales.pipeline'], document);
  vatSettingsData.invalidate();
});

afterEach(() => {
  for (const { container, root } of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  rstest.unstubAllGlobals();
});

const showWith = (granted: VatChangeRights) =>
  Effect.sync(() => {
    rights.current = granted;
  }).pipe(Effect.andThen(render()), Effect.andThen(waitUntil(() => text().includes(`${ns}.regime.VAT_PAYER`))));
const offered = () => buttons().filter((label) => editing.includes(label));

it.effect('a read-only accountant sees the regime and the rates with their history, and no change is offered', () =>
  Effect.gen(function* readOnly() {
    yield* showWith({ createRevision: false, createRule: false, declareRegime: false, endRevision: false });
    // The regime with its history, the current rate, the planned rate and the missing classification are shown.
    expect(text()).toContain(`${ns}.state.current`);
    expect(text()).toContain(`${ns}.currentRate`);
    expect(text()).toContain(`${ns}.planned`);
    expect(text()).toContain(`${ns}.missing`);
    expect(text()).not.toContain(`${ns}.regimeHistoryHidden`);
    expect(offered()).toEqual([]);
  }),
);

it.effect('an owner sees every change and can open each', () =>
  Effect.gen(function* owner() {
    yield* showWith({ createRevision: true, createRule: true, declareRegime: true, endRevision: true });
    expect(offered().toSorted()).toEqual(editing.toSorted());
    yield* acted(() => {
      [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === `${ns}.plan`)?.click();
    });
    expect(text()).toContain(`${ns}.planTitle`);
  }),
);

it.effect('a person who may only end a planned rate is offered only the withdrawal', () =>
  Effect.gen(function* endOnly() {
    yield* showWith({ createRevision: false, createRule: false, declareRegime: false, endRevision: true });
    expect(offered()).toEqual([`${ns}.withdraw`]);
  }),
);

it.effect('Tax without a navigation entry still runs for the company: the page shows its regime and rates', () =>
  Effect.gen(function* withoutNavigationEntry() {
    // The navigation hint lists no `commerce.tax`, exactly as stage: the page must not read that as "not installed".
    yield* showWith({ createRevision: false, createRule: false, declareRegime: false, endRevision: false });
    expect(text()).not.toContain(`${ns}.notInstalled`);
    expect(text()).toContain(`${ns}.currentRate`);
  }),
);

it.effect('Tax installed but no regime declared: the page says so and what to do, not that Tax is off', () =>
  Effect.gen(function* notDeclared() {
    taxState.current = 'notDeclared';
    yield* render();
    yield* waitUntil(() => text().includes(`${ns}.notDeclared`));
    expect(text()).toContain(`${ns}.notDeclaredDescription`);
    expect(text()).not.toContain(`${ns}.notInstalled`);
  }),
);

it.effect("Tax not installed for the tenant: the page says exactly that, from the Shell's own answer", () =>
  Effect.gen(function* notInstalled() {
    taxState.current = 'notInstalled';
    yield* render();
    yield* waitUntil(() => text().includes(`${ns}.notInstalled`));
    expect(text()).toContain(`${ns}.notInstalledDescription`);
    expect(text()).not.toContain(`${ns}.forbidden`);
  }),
);

it("the Shell's refusal names the page state: not installed, temporarily unavailable, or no access", () => {
  const forbidden = 'https://ontos.dev/problems/gateway-forbidden';
  expect(gatewayRefusalState({ type: 'https://ontos.dev/problems/gateway-module-not-installed' })).toEqual({
    state: 'notInstalled',
  });
  expect(gatewayRefusalState({ reason: 'audience_module_not_active', type: forbidden })).toEqual({
    state: 'unavailable',
  });
  expect(gatewayRefusalState({ reason: 'scope_unavailable', type: forbidden })).toEqual({ state: 'unavailable' });
  expect(gatewayRefusalState({ reason: 'scope_refused', type: forbidden })).toEqual({ state: 'forbidden' });
});
