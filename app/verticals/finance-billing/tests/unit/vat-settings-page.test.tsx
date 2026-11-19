// @rstest-environment happy-dom
// The DPH page offers a VAT change only when Tax says the signed-in person may make it. A read-only accountant sees the
// regime with its history and the rates with their plans, and no control that would change them; an owner sees and
// can use every one. Tax itself still refuses a change from a person without the right (tax-vat-settings-postgres
// proves that refusal on the server). The page runs on its real i18n, router and Tax clients; the Shell's gateway
// issuer and Tax's reads answer in process through their HttpApi contracts.
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  GATEWAY_MODULE_NOT_INSTALLED_TYPE,
  GatewayForbiddenProblemSchema,
  pinDocumentNavigationModules,
} from '@app/shared-contracts';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import {
  ApplicableTaxRuleSetApi,
  ApplicableTaxRuleSetResponseSchema,
} from '../../../tax/shared/apis/applicable-tax-rule-set.ts';
import {
  SellerVatRegimeAtInstantApi,
  SellerVatRegimeAtInstantResponseSchema,
} from '../../../tax/shared/apis/seller-vat-regime-at-instant.ts';
import {
  SellerVatRegimeHistoryApi,
  SellerVatRegimeHistoryResponseSchema,
} from '../../../tax/shared/apis/seller-vat-regime-history.ts';
import { TaxRuleHistoryApi, TaxRuleHistoryResponseSchema } from '../../../tax/shared/apis/tax-rule-history.ts';
import { VatChangeRightsApi } from '../../../tax/shared/apis/vat-change-rights.ts';
import type { VatChangeRights } from '../../src/routes/[lang]/finance/dph/tax-access.ts';
import { VatPage } from '../../src/routes/[lang]/finance/dph/page.tsx';
import { gatewayRefusalState, vatSettingsData } from '../../src/routes/[lang]/finance/dph/vat-settings-data.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const ns = 'finance-billing.vatSettings';
const czech = moduleText('cs');
const say = (key: string, values: Readonly<Record<string, string>> = {}) => czech(`${ns}.${key}`, values);
const fingerprint = (digit: string) => digit.repeat(64);
const standard = 'cz.vat.standard';

const ruleRef = {
  moduleId: 'commerce.tax',
  resourceId: 'rule-standard',
  resourceType: 'commerce.tax.tax-rule',
  tenantId: TENANT,
} as const;
const revisionRef = (id: string) => ({
  moduleId: 'commerce.tax',
  resourceId: id,
  resourceType: 'commerce.tax.tax-rule-revision',
  tenantId: TENANT,
});
const attribution = { provenanceRef: 'ontos:test', reason: 'Test fixture', recordedAt: '2023-12-01T00:00:00.000Z' };
const rateRevision = (id: string, ratePercent: string, effectiveFrom: string, effectiveTo: string | null) => ({
  compositionKind: 'EXCLUSIVE',
  effectiveFrom,
  effectiveTo,
  ratePercent,
  semanticFingerprint: fingerprint(ratePercent === '21' ? '2' : '3'),
  taxRuleRevisionRef: revisionRef(id),
  treatmentCategory: 'TAXABLE',
});

/** The standard rate has a rule (21 % since 2024 and 23 % planned for 2099); the reduced one has none yet. */
const applicableRuleOf = (code: string) =>
  Schema.decodeUnknownSync(ApplicableTaxRuleSetResponseSchema)({
    applicable:
      code === standard
        ? [
            {
              ...rateRevision('revision-21', '21', '2023-12-31T23:00:00.000Z', '2098-12-31T23:00:00.000Z'),
              endedEffectiveTo: null,
              revisionNumber: 1,
              taxRuleRef: ruleRef,
            },
          ]
        : [],
    completeness: {
      predicate: { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: code },
      predicateFingerprint: fingerprint('4'),
      rowCount: code === standard ? 1 : 0,
      setFingerprint: fingerprint('5'),
    },
    excludedByCorrection: [],
    outcome: 'SELECTED',
    taxRelevantTime: '2026-11-18T00:00:00.000Z',
  });
const ruleHistory = Schema.decodeUnknownSync(TaxRuleHistoryResponseSchema)({
  basisFingerprint: fingerprint('1'),
  corrections: [],
  meaningKind: 'VAT_RATE',
  revisions: [
    {
      ...attribution,
      ...rateRevision('revision-21', '21', '2023-12-31T23:00:00.000Z', '2098-12-31T23:00:00.000Z'),
      endFact: null,
      jurisdiction: 'CZ_DOMESTIC',
      revisionNumber: 1,
      supersedesRevisionRef: null,
      taxClassificationCode: standard,
    },
    {
      ...attribution,
      ...rateRevision('revision-23', '23', '2098-12-31T23:00:00.000Z', null),
      endFact: null,
      jurisdiction: 'CZ_DOMESTIC',
      revisionNumber: 2,
      supersedesRevisionRef: null,
      taxClassificationCode: standard,
    },
  ],
  stableCode: standard,
  taxRuleRef: ruleRef,
});
/** What Tax answers for the company's regime: a declared VAT payer, or nothing declared yet. */
const regimeAt = (declared: boolean) =>
  Schema.decodeUnknownSync(SellerVatRegimeAtInstantResponseSchema)({
    completeness: { rowCount: declared ? 1 : 0, setFingerprint: fingerprint('0') },
    headRevision: declared ? 1 : 0,
    instant: '2026-11-18T00:00:00.000Z',
    selection: declared
      ? {
          _tag: 'DECLARED',
          declarationRevisionRef: { revision: 1 },
          effectiveFrom: '2023-12-31T23:00:00.000Z',
          effectiveFromOrigin: 'DECLARED',
          provenance: 'MERCHANT_DECLARED',
          regime: 'VAT_PAYER',
        }
      : { _tag: 'NOT_DECLARED' },
  });
const regimeHistory = Schema.decodeUnknownSync(SellerVatRegimeHistoryResponseSchema)({
  completeness: { rowCount: 1, setFingerprint: fingerprint('0') },
  revisions: [
    {
      declarationRef: {
        moduleId: 'commerce.tax',
        resourceId: 'declaration-1',
        resourceType: 'commerce.tax.seller-vat-regime-declaration',
        tenantId: TENANT,
      },
      declaredBy: 'b0000000-0000-4000-8000-000000000001',
      effectiveFrom: '2023-12-31T23:00:00.000Z',
      effectiveFromOrigin: 'DECLARED',
      provenance: 'MERCHANT_DECLARED',
      reason: null,
      recordedAt: '2023-12-01T00:00:00.000Z',
      regime: 'VAT_PAYER',
      replacesScheduled: false,
      revision: 1,
    },
  ],
});

/** Which VAT changes Tax lets the signed-in person make, and whether the company declared a regime; each test sets it. */
let rights: VatChangeRights = { createRevision: false, createRule: false, declareRegime: false, endRevision: false };
let declared = true;
/** Whether Tax is installed for the tenant; when it is not, the Shell refuses the Tax audience as not installed. */
let taxInstalled = true;
const taxNotInstalled = GatewayForbiddenProblemSchema.make({
  detail: 'The module the call is for is not installed for the tenant.',
  reason: 'audience_module_not_installed',
  status: 403,
  title: 'Module not installed',
  type: GATEWAY_MODULE_NOT_INSTALLED_TYPE,
});

const Applicable = ApplicableTaxRuleSetApi.prefix('/tax-api');
const RuleHistory = TaxRuleHistoryApi.prefix('/tax-api');
const RegimeAt = SellerVatRegimeAtInstantApi.prefix('/tax-api');
const RegimeHistory = SellerVatRegimeHistoryApi.prefix('/tax-api');
const ChangeRights = VatChangeRightsApi.prefix('/tax-api');
const network = browserNetwork(
  shellGatewayIssuer({ tax: '/tax-api' }, (audience) =>
    audience === 'tax' && !taxInstalled ? taxNotInstalled : undefined,
  ).application,
  serveApi(
    Applicable,
    HttpApiBuilder.group(Applicable, 'applicableTaxRuleSet', (group) =>
      group.handle('execute', ({ payload }) => Effect.sync(() => applicableRuleOf(payload.taxClassificationCode))),
    ),
  ),
  serveApi(
    RuleHistory,
    HttpApiBuilder.group(RuleHistory, 'taxRuleHistory', (group) =>
      group.handle('execute', () => Effect.succeed(ruleHistory)),
    ),
  ),
  serveApi(
    RegimeAt,
    HttpApiBuilder.group(RegimeAt, 'sellerVatRegimeAtInstant', (group) =>
      group.handle('execute', () => Effect.sync(() => regimeAt(declared))),
    ),
  ),
  serveApi(
    RegimeHistory,
    HttpApiBuilder.group(RegimeHistory, 'sellerVatRegimeHistory', (group) =>
      group.handle('execute', () => Effect.succeed(regimeHistory)),
    ),
  ),
  serveApi(
    ChangeRights,
    HttpApiBuilder.group(ChangeRights, 'vatChangeRights', (group) =>
      group.handle('execute', () => Effect.sync(() => rights)),
    ),
  ),
);

const context: ModulePageProps['context'] = { legalEntityId: 'company-a', principalId: 'person-a', tenantId: TENANT };
const text = () => document.body.textContent ?? '';
const buttons = () => [...document.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
const editing = () => [say('regimeChange'), say('plan'), say('withdraw'), say('firstRate')];
const offered = () => buttons().filter((label) => editing().includes(label));

const render = Effect.gen(function* mount() {
  yield* pinTestDocument;
  yield* mountInRoute(<VatPage context={context} />, { path: 'finance/dph', url: '/cs/finance/dph' });
});
const showWith = (granted: VatChangeRights) =>
  Effect.sync(() => {
    rights = granted;
  }).pipe(Effect.andThen(render), Effect.andThen(waitUntil(() => text().includes(say('regime.VAT_PAYER')))));

beforeEach(() => {
  declared = true;
  taxInstalled = true;
  // As on stage: the Shell pins the navigation of the person's company, and Tax has no navigation entry of its own.
  pinDocumentNavigationModules(['finance.billing', 'demo.merchandise', 'sales.pipeline'], document);
  vatSettingsData.invalidate();
});

afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('vat settings page', (suite) => {
  suite.effect(
    'a read-only accountant sees the regime and the rates with their history, and no change is offered',
    () =>
      Effect.gen(function* readOnly() {
        yield* showWith({ createRevision: false, createRule: false, declareRegime: false, endRevision: false });
        // The regime with its history, the current rate, the planned rate and the missing classification are shown.
        expect(text()).toContain(say('state.current'));
        expect(text()).toContain(say('currentRate', { date: '1. 1. 2024', rate: '21' }));
        expect(text()).toContain(say('planned'));
        expect(text()).toContain(say('missing'));
        expect(text()).not.toContain(say('regimeHistoryHidden'));
        expect(offered()).toEqual([]);
      }),
  );

  suite.effect('an owner sees every change and can open each', () =>
    Effect.gen(function* owner() {
      yield* showWith({ createRevision: true, createRule: true, declareRegime: true, endRevision: true });
      expect(offered().toSorted()).toEqual(editing().toSorted());
      yield* acted(() => {
        [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === say('plan'))?.click();
      });
      yield* waitUntil(() => text().includes(say('planTitle', { name: 'Základní sazba DPH' })));
    }),
  );

  suite.effect('a person who may only end a planned rate is offered only the withdrawal', () =>
    Effect.gen(function* endOnly() {
      yield* showWith({ createRevision: false, createRule: false, declareRegime: false, endRevision: true });
      expect(offered()).toEqual([say('withdraw')]);
    }),
  );

  suite.effect('Tax installed but no regime declared: the page says so and what to do, not that Tax is off', () =>
    Effect.gen(function* notDeclared() {
      declared = false;
      yield* render;
      yield* waitUntil(() => text().includes(say('notDeclared')));
      expect(text()).toContain(say('notDeclaredDescription'));
      expect(text()).not.toContain(say('notInstalled'));
    }),
  );

  suite.effect("Tax not installed for the tenant: the page says exactly that, from the Shell's own answer", () =>
    Effect.gen(function* notInstalled() {
      taxInstalled = false;
      yield* render;
      yield* waitUntil(() => text().includes(say('notInstalled')));
      expect(text()).toContain(say('notInstalledDescription'));
      expect(text()).not.toContain(say('forbidden'));
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
});
