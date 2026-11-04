import { isRedirect } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Option, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';

import { loader } from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/resource-page-model.ts';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';
import {
  AppIdSchema,
  EntrypointKeySchema,
  GroupKeySchema,
  ModuleIdSchema,
  ShellResourceResponseSchema,
} from '../../../../shared/api.ts';
import type { ShellNavigationItem, ShellRecordDestination } from '../../../../shared/api.ts';

const { loadHomePageModelMock, resourceDetailMock } = rstest.hoisted(() => ({
  loadHomePageModelMock: rstest.fn(),
  resourceDetailMock: rstest.fn(),
}));

rstest.mock('../../../../src/routes/[lang]/home-page-model.ts', () => ({
  loadHomePageModel: loadHomePageModelMock,
  sessionEndedModel: { state: 'anonymous' },
}));
rstest.mock('../../../../src/api/auth-client.ts', () => ({ resourceDetail: resourceDetailMock }));

const evaId = 'ea2200ab-4308-491e-8e33-ca3871a8fa55';
const counterparty = { moduleId: 'party.registry', resourceId: evaId, resourceType: 'party.registry.counterparty' };
const company = authenticatedShellFixture().selectedLegalEntityId;
const otherCompany = '20000000-0000-4000-8000-000000000002';

const navigationItem = (moduleId: string, groupKey: string, href: string): ShellNavigationItem => ({
  appId: AppIdSchema.make('shell-super-app'),
  enabled: true,
  entrypointKey: EntrypointKeySchema.make(`${moduleId}.page.agenda`),
  groupKey: GroupKeySchema.make(groupKey),
  href,
  icon: 'icon-[mdi--file-outline]',
  label: { cs: href, en: href },
  moduleId: ModuleIdSchema.make(moduleId),
  order: 0,
  state: 'active',
  unavailable: false,
  writable: true,
});

/** The Party identity page the party owner declares for its own record type. */
const partyRecordDestination: ShellRecordDestination = {
  idParameter: 'partyId',
  moduleId: ModuleIdSchema.make('party.registry'),
  resourceType: 'party.registry.party',
  routePath: '/prodej/strany/:partyId',
};

/** The composed navigation a loaded Shell document has; the record targets are resolved from it, never repeated. */
const shell = (recordDestinations: readonly ShellRecordDestination[] = []) => {
  const fixture = authenticatedShellFixture();
  const items = [
    navigationItem('demo.crm', 'shell.navigation.sales', '/crm/klienti'),
    navigationItem('finance.billing', 'shell.navigation.finance', '/finance'),
    navigationItem('party.registry', 'shell.navigation.sales', '/prodej/zakaznici'),
    navigationItem('demo.merchandise', 'shell.navigation.commerce', '/prodej/objednavky'),
    navigationItem('demo.merchandise', 'shell.navigation.commerce', '/provoz/produkty'),
    navigationItem('facility.operations', 'shell.navigation.facility', '/provoz/majetek'),
    navigationItem('property.portfolio', 'shell.navigation.real-estate', '/nemovitosti'),
    navigationItem('legal.agreements', 'shell.navigation.sales', '/smlouvy'),
    navigationItem('work.tasks', 'shell.navigation.team', '/ukoly'),
  ];
  return {
    ...fixture,
    navigation: { ...fixture.navigation, items, moduleIds: items.map(({ moduleId }) => moduleId), recordDestinations },
  };
};

const requestFor = (params: typeof counterparty, prefix = 'generic') =>
  new Request(
    `https://shell.example.test/${prefix}/resources/${params.moduleId}/${params.resourceType}/${encodeURIComponent(params.resourceId)}?resourceId=attacker&redirect=https://attacker.test`,
  );

beforeEach(() => {
  loadHomePageModelMock.mockReturnValue(Effect.succeed(shell()));
  resourceDetailMock.mockImplementation((ref) => Effect.succeed({ outcome: 'detail_not_supported', ref }));
});

const rejected = (params: typeof counterparty, prefix = 'generic') =>
  Effect.flip(
    Effect.tryPromise({ catch: (cause) => cause, try: () => loader({ params, request: requestFor(params, prefix) }) }),
  );

it.effect.each([
  [counterparty, `/cs/prodej/zakaznici/${evaId}`],
  [{ moduleId: 'demo.crm', resourceId: evaId, resourceType: 'demo.crm.contact' }, `/cs/crm/klienti?osoba=${evaId}`],
  [
    { moduleId: 'finance.billing', resourceId: evaId, resourceType: 'finance.billing.document' },
    `/cs/finance?documentId=${evaId}`,
  ],
  [
    { moduleId: 'core.identity', resourceId: `${company}.${evaId}`, resourceType: 'core.identity.person' },
    `/cs/sprava/lide-a-role?person=${company}.${evaId}`,
  ],
  [
    { moduleId: 'demo.merchandise', resourceId: `${company}.${evaId}`, resourceType: 'demo.merchandise.product' },
    `/cs/provoz/produkty/${evaId}`,
  ],
  [
    { moduleId: 'demo.merchandise', resourceId: `${company}.OBJ-42`, resourceType: 'demo.merchandise.order' },
    '/cs/prodej/objednavky?orderId=OBJ-42',
  ],
  [
    { moduleId: 'facility.operations', resourceId: `${company}.TEC-001`, resourceType: 'facility.operations.asset' },
    '/cs/provoz/majetek?asset=TEC-001',
  ],
  [
    { moduleId: 'work.tasks', resourceId: 'task 42&other=1', resourceType: 'work.tasks.task' },
    '/cs/ukoly?resourceId=task+42%26other%3D1',
  ],
] as const)('legacy resources open the exact owner record without search-history state: %s', ([params, href]) =>
  Effect.gen(function* reloadOpensExactOwnerRecord() {
    const result = yield* rejected(params);
    expect(isRedirect(result)).toBe(true);
    expect(result).toMatchObject({ options: { to: href } });
    expect(resourceDetailMock).toHaveBeenCalledTimes(1);
    expect(resourceDetailMock.mock.calls[0]?.[0]).toMatchObject({
      ...params,
      compositionRevision: authenticatedShellFixture().compositionRevision,
    });
  }),
);

it.effect('retains the language prefix and never trusts an unrelated legacy query', () =>
  Effect.gen(function* localizedOwnerRedirect() {
    const result = yield* rejected(counterparty, 'cs');
    expect(isRedirect(result)).toBe(true);
    expect(result).toMatchObject({ options: { to: `/cs/prodej/zakaznici/${evaId}` } });
  }),
);

it.effect('opens the Party identity page only when the owner declared that record destination', () =>
  Effect.gen(function* partyIdentityRedirectsOnlyOnceDeclared() {
    // The owner page declares the record destination, so the Shell opens the exact identity page.
    const params = { moduleId: 'party.registry', resourceId: evaId, resourceType: 'party.registry.party' };
    loadHomePageModelMock.mockReturnValueOnce(Effect.succeed(shell([partyRecordDestination])));
    const result = yield* rejected(params);
    expect(isRedirect(result)).toBe(true);
    expect(result).toMatchObject({ options: { to: `/cs/prodej/strany/${evaId}` } });
    // Without that declaration the admitted record keeps the Shell record page: no route is guessed from the type.
    expect(yield* Effect.promise(() => loader({ params, request: requestFor(params) }))).toMatchObject({
      detailSupport: 'not_supported',
      state: 'unavailable',
    });
    // A namespace-consistent ref of a composed module that does not declare the destination is not an owner record.
    const forged = { moduleId: 'demo.crm', resourceId: evaId, resourceType: 'demo.crm.product' };
    resourceDetailMock.mockReturnValueOnce(Effect.succeed({ outcome: 'detail_not_supported', ref: forged }));
    expect(yield* Effect.promise(() => loader({ params: forged, request: requestFor(forged) }))).toMatchObject({
      detailSupport: 'not_supported',
      state: 'unavailable',
    });
  }),
);

it.effect('keeps an admitted English owner link in English', () =>
  Effect.gen(function* englishOwnerRedirect() {
    const result = yield* rejected(counterparty, 'en');
    expect(result).toMatchObject({ options: { to: `/en/prodej/zakaznici/${evaId}` } });
  }),
);

it('the unsupported wire response carries no guessed name or private detail fields', () => {
  const response = { outcome: 'detail_not_supported', ref: counterparty };
  expect(Schema.decodeUnknownSync(ShellResourceResponseSchema)(response)).toEqual(response);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(ShellResourceResponseSchema, { onExcessProperty: 'error' })({
        ...response,
        detail: { fields: [{ label: 'E-mail', value: 'private@example.test' }], title: 'Eva Bílá' },
      }),
    ),
  ).toBe(true);
});

it.live.each([
  ['ShellTargetForbiddenProblem', 'forbidden'],
  ['ShellTargetNotFoundProblem', 'not_found'],
  ['ShellCapabilityUnavailableProblem', 'unavailable'],
  ['HttpClientError', 'unavailable'],
  ['ShellReloadRequiredProblem', 'reload_required'],
] as const)('never redirects a denied, deleted, unknown or unavailable record: %s', ([tag, state]) =>
  Effect.gen(function* noRedirectOnReadFailure() {
    resourceDetailMock.mockReturnValueOnce(Effect.fail({ _tag: tag }));
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({
      state,
    });
  }),
);

it.live.each([
  { moduleId: 'legal.agreements', resourceId: evaId, resourceType: 'legal.agreements.document' },
  { ...counterparty, moduleId: 'demo.crm' },
  { ...counterparty, resourceId: 'malformed' },
  { moduleId: 'future.owner', resourceId: evaId, resourceType: 'future.owner.record' },
  { moduleId: 'demo.merchandise', resourceId: `${otherCompany}.${evaId}`, resourceType: 'demo.merchandise.product' },
  { moduleId: 'demo.merchandise', resourceId: `${company}.`, resourceType: 'demo.merchandise.product' },
])('unsupported or mismatched identities do not become a different record: %s', (params) =>
  Effect.gen(function* noInventedOwnerRecord() {
    expect(yield* Effect.promise(() => loader({ params, request: requestFor(params) }))).toMatchObject({
      state: 'unavailable',
    });
  }),
);

it.live('never redirects an unsupported response for a different record', () =>
  Effect.gen(function* validatesUnsupportedReference() {
    resourceDetailMock.mockReturnValueOnce(
      Effect.succeed({
        outcome: 'detail_not_supported',
        ref: { ...counterparty, resourceId: '00000000-0000-4000-8000-000000000001' },
      }),
    );
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({
      state: 'unavailable',
    });
  }),
);

it.effect('a new scope makes a fresh resource read and cannot reuse another company admission', () =>
  Effect.gen(function* scopeChangesDoNotCacheAdmission() {
    const params = {
      moduleId: 'demo.merchandise',
      resourceId: `${company}.${evaId}`,
      resourceType: 'demo.merchandise.product',
    };
    expect(isRedirect(yield* rejected(params))).toBe(true);
    loadHomePageModelMock.mockReturnValueOnce(
      Effect.succeed({ ...authenticatedShellFixture(), selectedLegalEntityId: otherCompany }),
    );
    expect(yield* Effect.promise(() => loader({ params, request: requestFor(params) }))).toMatchObject({
      state: 'unavailable',
    });
    expect(resourceDetailMock).toHaveBeenCalledTimes(2);
    expect(loadHomePageModelMock).toHaveBeenCalledTimes(2);
  }),
);

it.live('does not read or redirect before composition admission', () =>
  Effect.gen(function* admissionFirst() {
    loadHomePageModelMock.mockReturnValueOnce(Effect.succeed({ state: 'reload_required' }));
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({ state: 'reload_required' });
    expect(resourceDetailMock).not.toHaveBeenCalled();
  }),
);

it.live('does not carry private details from a successful read into a later denied scope', () =>
  Effect.gen(function* privateDetailsStayInTheirRequest() {
    resourceDetailMock.mockReturnValueOnce(
      Effect.succeed({
        detail: { fields: [{ label: 'E-mail', value: 'private@example.test' }], title: 'Eva Bílá' },
        media: { enabled: false, reason: 'absent' },
        projectionLagging: false,
        ref: counterparty,
        timeline: [],
      }),
    );
    expect(
      yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) })),
    ).toMatchObject({
      state: 'ready',
    });
    loadHomePageModelMock.mockReturnValueOnce(
      Effect.succeed({ ...authenticatedShellFixture(), selectedLegalEntityId: otherCompany }),
    );
    resourceDetailMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellTargetForbiddenProblem' }));
    const denied = yield* Effect.promise(() => loader({ params: counterparty, request: requestFor(counterparty) }));
    expect(denied).toEqual({
      shell: { ...authenticatedShellFixture(), selectedLegalEntityId: otherCompany },
      state: 'forbidden',
    });
    expect(JSON.stringify(denied)).not.toContain('private@example.test');
    expect(resourceDetailMock).toHaveBeenCalledTimes(2);
  }),
);
