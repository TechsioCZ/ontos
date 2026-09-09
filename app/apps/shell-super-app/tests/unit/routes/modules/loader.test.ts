import { Cause, ConfigProvider, Deferred, Effect, Fiber } from 'effect';
import { beforeEach, expect, rstest, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import { loadModulePageModel, selectRouteParams } from '../../../../src/routes/[lang]/modules/[moduleId]/page.data.ts';

const { loadHomePageModelMock, resolveModuleTargetMock } = rstest.hoisted(() => ({
  loadHomePageModelMock: rstest.fn(),
  resolveModuleTargetMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  resolveModuleTarget: resolveModuleTargetMock,
}));

rstest.mock('../../../../src/routes/[lang]/page.data.ts', () => ({
  loadHomePageModel: loadHomePageModelMock,
}));

const authenticatedShell = {
  contextState: 'authenticated' as const,
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId: 'legal-1',
    legalName: 'Alpha company',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  legalEntities: { items: [], state: 'available' as const },
  navigation: { items: [], state: 'available' as const },
  selectedLegalEntityId: 'legal-1',
  state: 'authenticated' as const,
  tenants: { items: [], state: 'available' as const },
};

const request = () => {
  const value = new Request('https://shell.example.test/en/contacts');
  Object.defineProperty(value, 'headers', {
    value: new Headers({ cookie: 'session=test-session' }),
  });
  return value;
};

/** The module program reads its origin from config; pin an empty provider so every case is identical. */
const moduleModel = (input: Parameters<typeof loadModulePageModel>[0]) =>
  loadModulePageModel(input).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})));

beforeEach(() => {
  loadHomePageModelMock.mockReturnValue(Effect.succeed(authenticatedShell));
  resolveModuleTargetMock.mockReturnValue(
    Effect.succeed({
      appId: 'party-registry',
      componentKey: 'party.registry.page-contacts',
      entrypointKey: 'party.registry.page.contacts',
      moduleId: 'party.registry',
      writable: false,
    }),
  );
});

it('selects only declared safe route parameters and omits overlong values', () => {
  expect(
    selectRouteParams(
      {
        appId: 'attacker-app',
        id: 'party-1',
        moduleId: 'attacker.module',
        overlong: 'x'.repeat(201),
      },
      ['id', 'overlong'],
    ),
  ).toEqual({ id: 'party-1' });
});

it.effect('retains only declared bounded route parameters outside the resolved target identity', () =>
  Effect.gen(function* retainsOnlyDeclaredBoundedRouteParameters() {
    expect(
      yield* moduleModel({
        params: {
          entrypointKey: 'party.registry.page.contacts',
          moduleId: 'party.registry',
        },
        request: request(),
        routeParams: { id: 'party-1' },
      }),
    ).toMatchObject({
      routeParams: { id: 'party-1' },
      state: 'resolved',
      target: {
        appId: 'party-registry',
        componentKey: 'party.registry.page-contacts',
        entrypointKey: 'party.registry.page.contacts',
        moduleId: 'party.registry',
      },
    });
    expect(resolveModuleTargetMock).toHaveBeenCalledWith(
      {
        entrypointKey: 'party.registry.page.contacts',
        moduleId: 'party.registry',
      },
      expect.any(Object),
    );
  }),
);

it.effect('retains module landing behavior when no exact page entrypoint is supplied', () =>
  Effect.gen(function* retainsModuleLandingBehaviorWhenNo() {
    expect(
      yield* moduleModel({
        params: { moduleId: 'party.registry' },
        request: request(),
      }),
    ).toMatchObject({ routeParams: {} });
    expect(resolveModuleTargetMock).toHaveBeenCalledWith({ moduleId: 'party.registry' }, expect.any(Object));
  }),
);

it.effect('does not request or load a private target before authentication', () =>
  Effect.gen(function* doesNotRequestOrLoadA() {
    loadHomePageModelMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' }));
    expect(
      yield* moduleModel({
        params: {
          entrypointKey: 'party.registry.page.contacts',
          moduleId: 'party.registry',
        },
        request: request(),
      }),
    ).toMatchObject({ state: 'selection_required' });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
  }),
);

it.effect.each([
  ['ShellSelectionRequiredProblem', 'selection_required'],
  ['ShellTargetForbiddenProblem', 'forbidden'],
  ['ShellTargetNotFoundProblem', 'not_found'],
  ['ShellCapabilityUnavailableProblem', 'unavailable'],
] as const)('maps %s without returning a resolved private target', ([_tag, state]) =>
  Effect.gen(function* ShellSelectionRequiredProblem() {
    resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag }));
    expect(
      yield* moduleModel({
        params: {
          entrypointKey: 'party.registry.page.contacts',
          moduleId: 'party.registry',
        },
        request: request(),
      }),
    ).toMatchObject({ state });
  }),
);

it.effect('fails with the typed timeout instead of hanging on an unresponsive shell read', () =>
  Effect.gen(function* failsWithTheTypedTimeout() {
    const entered = yield* Deferred.make<'entered'>();
    loadHomePageModelMock.mockReturnValueOnce(Effect.andThen(Deferred.succeed(entered, 'entered'), Effect.never));
    const fiber = yield* Effect.forkChild(
      moduleModel({
        params: { moduleId: 'party.registry' },
        request: request(),
      }),
    );
    yield* Deferred.await(entered);

    yield* TestClock.adjust('30 seconds');

    expect(yield* Effect.flip(Fiber.join(fiber))).toBeInstanceOf(Cause.TimeoutError);
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
  }),
);
