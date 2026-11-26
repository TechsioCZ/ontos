import { ActionPermissionDenied } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ManageSymmyRoutesPayloadSchema, ManageSymmyRoutesRejected } from '../../shared/actions/manage-symmy-routes.ts';
import { manageSymmyRoutesAction } from '../../src/actions/manage-symmy-routes.action.ts';
import type { manageSymmyRoutesServices } from '../../src/actions/manage-symmy-routes.action.ts';
import { SymmyRouteEnrollmentRefused } from '../../src/ops/symmy-route-enrollment-refused.ts';
import { symmyManagedRouteId } from '../../src/ops/symmy-route-templates.ts';
import { symmyIntegrationRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const adminPrincipalId = '33333333-3333-4333-8333-333333333333';
const integrationPrincipalId = '44444444-4444-4444-8444-444444444444';
const source = { issuerId: 'symmy-akros', sourceNamespace: 'akros-erp' };

type Services = Effect.Success<ReturnType<typeof manageSymmyRoutesServices>>;
type EnableInput = Parameters<Services['enable']>[0];
type DisableInput = Parameters<Services['disable']>[0];

const principal = {
  authBindingId: '55555555-5555-4555-8555-555555555555',
  authContextRef: 'better-auth-session:symmy-routes',
  authMethod: 'session' as const,
  legalEntityId,
  principalId: adminPrincipalId,
  tenantId,
};
const payload = Schema.decodeUnknownSync(ManageSymmyRoutesPayloadSchema)({
  changes: [
    {
      kind: 'enable',
      routeKey: 'priceLists',
      settings: { priceReadSource: { ownerModuleId: 'external.symmy', sourceSystemRef: 'symmy-akros' }, source },
    },
    { kind: 'enable', routeKey: 'productsBatch', settings: { retentionDays: 30, source } },
    { expectedChangeToken: 7, kind: 'disable', routeKey: 'adminRegions' },
  ],
  integrationPrincipalId,
  reason: 'Connect Symmy to the company',
});

/** Store stand-ins that record what the Action asks of them and answer as an applied change. */
const recordingServices = () => {
  const enabled: EnableInput[] = [];
  const disabled: DisableInput[] = [];
  const services: Services = {
    disable: (input) => {
      disabled.push(input);
      return Effect.succeed({
        changeToken: input.expectedChangeToken + 1,
        executors: [],
        outcome: 'deactivated' as const,
        requiredBindings: [],
        routeId: input.reference.routeId,
        routeKey: input.reference.routeKey,
        sourcePeers: [],
      });
    },
    enable: (input) => {
      enabled.push(input);
      return Effect.succeed({
        changeToken: enabled.length,
        executors: [],
        outcome: 'enrolled' as const,
        requiredBindings: [],
        routeId: input.request.routeId,
        routeKey: input.request.routeKey,
        sourcePeers: [],
      });
    },
  };
  return { disabled, enabled, services };
};

const run = (access: 'allowed' | 'denied', services: Services, key: string) =>
  Effect.gen(function* runManageSymmyRoutes() {
    const harness = yield* makeActionTestHarness({
      access,
      ownerRegistration: symmyIntegrationRegistration,
      services: [bindActionTestServices(manageSymmyRoutesAction, services)],
    });
    const outcome = yield* harness.runtime
      .runAction({
        payload,
        principal,
        registration: manageSymmyRoutesAction,
        transport: { correlationId: `symmy-routes-${key}`, idempotencyKey: `symmy-routes-${key}` },
      })
      .pipe(Effect.result);
    return { harness, outcome };
  });

describe('integration.symmy.manage-symmy-routes', () => {
  it('is a critical, protected administrator capability of the selected company with an idempotency key', () => {
    const { descriptor } = manageSymmyRoutesAction;
    expect(descriptor.accessDeclaration).toMatchObject({
      key: 'integration.symmy.symmy-routes.manage',
      kind: 'admin',
      risk: 'critical',
    });
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    expect(descriptor.legalEntityScope).toBe('required');
    expect(descriptor.idempotency).toBe('required');
  });

  it.effect('refuses a principal without the Symmy route permission before any route is read or written', () =>
    Effect.gen(function* nonAdministrator() {
      const { disabled, enabled, services } = recordingServices();
      const { harness, outcome } = yield* run('denied', services, 'denied');
      expect(Result.isFailure(outcome) && Schema.is(ActionPermissionDenied)(outcome.failure)).toBe(true);
      expect(harness.snapshot().permissionDenials).toHaveLength(1);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
      expect(enabled).toHaveLength(0);
      expect(disabled).toHaveLength(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('enrolls every route in the caller Tenant and company, with its retention and price read source', () =>
    Effect.gen(function* administrator() {
      const { disabled, enabled, services } = recordingServices();
      const { outcome } = yield* run('allowed', services, 'allowed');
      expect(Result.isSuccess(outcome)).toBe(true);
      const scope = { legalEntityId, principalId: integrationPrincipalId, tenantId };
      expect(enabled.map(({ request }) => [request.tenantId, request.legalEntityId, request.principalId])).toEqual([
        [tenantId, legalEntityId, integrationPrincipalId],
        [tenantId, legalEntityId, integrationPrincipalId],
      ]);
      const [lists, products] = enabled;
      expect(lists?.change).toEqual({ kind: 'enroll' });
      expect(Option.getOrUndefined(lists?.priceReadSource ?? Option.none())).toEqual({
        ownerModuleId: 'external.symmy',
        sourceSystemRef: 'symmy-akros',
      });
      expect(Option.isNone(lists?.retentionPolicy ?? Option.none())).toBe(true);
      expect(products?.request.lifecyclePolicy).toEqual({ policyId: 'symmy-productsBatch', revision: '30d' });
      const policy = Option.getOrUndefined(products?.retentionPolicy ?? Option.none());
      expect(policy).toMatchObject({
        governanceLegalEntityId: legalEntityId,
        retentionMs: 30 * 86_400_000,
        routeId: products?.request.routeId,
        tenantId,
      });
      expect(disabled).toEqual([
        expect.objectContaining({
          expectedChangeToken: 7,
          reference: expect.objectContaining({
            legalEntityId,
            routeId: symmyManagedRouteId(scope, 'adminRegions'),
            tenantId,
          }),
        }),
      ]);
      expect(disabled[0]?.attribution.operatorRef.startsWith(`${adminPrincipalId}@`)).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('answers the refusals of every change at once, with the workloads still to grant', () =>
    Effect.gen(function* everyRefusal() {
      const { services } = recordingServices();
      const { outcome } = yield* run(
        'allowed',
        {
          ...services,
          enable: ({ request }) =>
            Effect.fail(
              new SymmyRouteEnrollmentRefused({
                refusals: [
                  {
                    code: 'integration_binding_missing',
                    detail: `${request.routeKey} needs its workload`,
                    workloads: [`integration.symmy-${request.routeKey}`],
                  },
                ],
              }),
            ),
        },
        'every-refusal',
      );
      const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
      expect(Schema.is(ManageSymmyRoutesRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({
        refusals: [
          { code: 'integration_binding_missing', workloads: ['integration.symmy-priceLists'] },
          { code: 'integration_binding_missing', workloads: ['integration.symmy-productsBatch'] },
        ],
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('answers every refusal of the enrollment and commits nothing', () =>
    Effect.gen(function* refusedChange() {
      const { services } = recordingServices();
      const { harness, outcome } = yield* run(
        'allowed',
        {
          ...services,
          enable: () =>
            Effect.fail(
              new SymmyRouteEnrollmentRefused({
                refusals: [
                  { code: 'integration_principal_not_active', detail: 'The integration principal is not_found' },
                ],
              }),
            ),
        },
        'refused',
      );
      const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
      expect(Schema.is(ManageSymmyRoutesRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({
        code: 'route_enrollment_refused',
        // Both enables are refused; the disable after them is decided too and rolled back with them.
        refusals: [{ code: 'integration_principal_not_active' }, { code: 'integration_principal_not_active' }],
      });
      expect(harness.snapshot().committed).toHaveLength(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
