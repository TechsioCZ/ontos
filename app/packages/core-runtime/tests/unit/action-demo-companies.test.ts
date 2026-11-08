import { ConfigProvider, Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { configureDemoCompaniesAction } from '../../src/modules/actions/configure-demo-companies.action.ts';
import {
  commercialDemoCompany,
  demoCompanyTenantId,
  rentalDemoCompany,
} from '../../src/install/demo-company-profiles.ts';
import { bindActionTestServices, makeActionTestHarness } from '../../src/testing/actions.ts';

const principal = {
  authBindingId: '77777777-7777-4777-8777-777777777777',
  authContextRef: 'better-auth-session:demo-company-configuration',
  authMethod: 'session',
  principalId: '88888888-8888-4888-8888-888888888888',
  tenantId: demoCompanyTenantId,
} as const;
const request = {
  payload: { configuration: 'sales-rental-v1' },
  principal,
  registration: configureDemoCompaniesAction,
  transport: { correlationId: 'configure-demo-company-test', idempotencyKey: 'demo-companies-once' },
};

it.effect('requires the canonical tenant administration grant before company state changes', () =>
  Effect.gen(function* deniedCompanyConfiguration() {
    const calls: string[] = [];
    const services = [
      bindActionTestServices(configureDemoCompaniesAction, {
        configure: () =>
          Effect.sync(() => {
            calls.push('configure');
            return {
              companies: [commercialDemoCompany, rentalDemoCompany],
              previousCompanyCount: 1,
              previousPrincipalCount: 4,
            };
          }),
      }),
    ];
    yield* Effect.forEach(
      [
        { access: 'denied', errorTag: 'ActionPermissionDenied' },
        { access: 'unavailable', errorTag: 'ActionPermissionCheckError' },
      ] as const,
      (options) =>
        Effect.gen(function* rejectsWithoutMutation() {
          const harness = yield* makeActionTestHarness({ access: options.access, services });
          const error = yield* harness.runtime.runAction(request).pipe(Effect.flip);
          expect(Predicate.isTagged(error, options.errorTag)).toBe(true);
          expect(harness.snapshot().committed).toHaveLength(0);
        }),
      { concurrency: 1 },
    );
    expect(calls).toEqual([]);
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development' }),
    ),
  ),
);

it.effect('audits fixed company and persona configuration in development and stage, rejecting production', () =>
  Effect.gen(function* auditedCompanyConfiguration() {
    const calls: string[] = [];
    const services = [
      bindActionTestServices(configureDemoCompaniesAction, {
        configure: () =>
          Effect.sync(() => {
            calls.push('configure');
            return {
              companies: [commercialDemoCompany, rentalDemoCompany],
              previousCompanyCount: 1,
              previousPrincipalCount: 4,
            };
          }),
      }),
    ];
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      services,
    });
    const result = yield* harness.runtime
      .runAction(request)
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development' }),
        ),
      );
    expect(result.companies).toEqual([commercialDemoCompany, rentalDemoCompany]);
    expect(calls).toEqual(['configure']);
    expect(harness.snapshot().committed[0]?.evidence.dataAccessEvents).toHaveLength(2);
    const stage = yield* makeActionTestHarness({
      access: 'allowed',
      services,
    });
    const stageResult = yield* stage.runtime
      .runAction(request)
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' }),
        ),
      );
    expect(stageResult.companies).toEqual(result.companies);
    expect(stage.snapshot().committed[0]?.evidence.dataAccessEvents).toHaveLength(2);
    const production = yield* makeActionTestHarness({
      access: 'allowed',
      services,
    });
    const error = yield* production.runtime
      .runAction(request)
      .pipe(
        Effect.flip,
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' }),
        ),
      );
    expect(Predicate.isTagged(error, 'IdentityTargetInvalidError')).toBe(true);
    expect(calls).toEqual(['configure', 'configure']);
    expect(production.snapshot().committed).toHaveLength(0);
  }),
);
