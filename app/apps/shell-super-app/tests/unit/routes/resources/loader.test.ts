import { isRedirect } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';

import { loader } from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/resource-page-model.ts';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';
import { ShellResourceResponseSchema } from '../../../../shared/api.ts';

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
const requestFor = (params: typeof counterparty, prefix = 'generic') =>
  new Request(
    `https://shell.example.test/${prefix}/resources/${params.moduleId}/${params.resourceType}/${encodeURIComponent(params.resourceId)}?resourceId=attacker&redirect=https://attacker.test`,
  );

beforeEach(() => {
  loadHomePageModelMock.mockReturnValue(Effect.succeed(authenticatedShellFixture()));
  resourceDetailMock.mockImplementation((ref) => Effect.succeed({ outcome: 'detail_not_supported', ref }));
});

const rejected = (params: typeof counterparty, prefix = 'generic') =>
  Effect.flip(
    Effect.tryPromise({ catch: (cause) => cause, try: () => loader({ params, request: requestFor(params, prefix) }) }),
  );

it.effect.each([
  [counterparty, `/cs/prodej/zakaznici/${evaId}`],
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
    Schema.decodeUnknownOption(ShellResourceResponseSchema, { onExcessProperty: 'error' })({
      ...response,
      detail: { fields: [{ label: 'E-mail', value: 'private@example.test' }], title: 'Eva Bílá' },
    })._tag,
  ).toBe('None');
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
  { ...counterparty, resourceType: 'party.registry.party' },
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
