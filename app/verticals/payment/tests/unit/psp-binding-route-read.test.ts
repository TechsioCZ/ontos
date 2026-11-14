import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind } from '@app/core-runtime/access/enforcement';
import { AccessScopeIdSchema, LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { bindAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import {
  PROVIDER_BINDING_ROUTE_OPERATIONS,
  ProviderBindingRouteKeySchema,
  ProviderBindingRouteResponseSchema,
} from '../../shared/apis/provider-binding-route.ts';
import { handleProviderBindingRoute, providerBindingRouteRead } from '../../src/api/provider-binding-route.read.ts';
import type { ProviderBindingRouteServices } from '../../src/api/provider-binding-route.read.ts';
import { ProviderBindingRouteRecordSchema } from '../../src/persistence/psp-binding-route-persistence.ts';
import type { ProviderBindingRouteRecord } from '../../src/persistence/psp-binding-route-persistence.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';

/**
 * #1157 / #1153 the workload-only provider binding route Read: Core admits only the relay and reconciliation
 * workloads, the handler answers only their API-key integration principals, and a route key resolves inside
 * the caller's Tenant to its binding, retired or not. Tenant isolation under RLS is proven natively in
 * `tests/integration/psp-binding-route-postgres.test.ts`.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '33333333-3333-4333-8333-333333333333';
const ROUTE_KEY = Schema.decodeUnknownSync(ProviderBindingRouteKeySchema)('A'.repeat(43));

const tenantScope = (authMethod: 'api_key' | 'session'): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '66666666-6666-4666-8666-666666666666',
    authContextRef: `fixture:${authMethod}`,
    authMethod,
    principalId: PRINCIPAL_ID,
    tenantId: TENANT_ID,
  }),
  correlationId: 'payment-binding-route-read',
});

const retiredRoute: ProviderBindingRouteRecord = Schema.decodeUnknownSync(ProviderBindingRouteRecordSchema)({
  bindingId: '44444444-4444-4444-8444-444444444444',
  bindingRef: `pab_${'a'.repeat(32)}`,
  bindingStatus: 'RETIRED_FOR_NEW_INTENTS',
  environment: 'SANDBOX',
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  providerFamily: 'GOPAY',
  routeRevision: 1,
  tenantId: TENANT_ID,
});

interface FakeRoute {
  readonly kind?: AccessPrincipalKind | 'unavailable';
  readonly route?: ProviderBindingRouteRecord | 'unavailable';
}

const servicesOf = (fake: FakeRoute, lookups: string[]): ProviderBindingRouteServices => ({
  readPrincipalKind: () =>
    fake.kind === 'unavailable'
      ? Effect.die('principal kind unavailable')
      : Effect.succeed(Option.some(fake.kind ?? 'integration')),
  resolveRouteKey: (routeKey) => {
    lookups.push(routeKey);
    return fake.route === 'unavailable'
      ? Effect.fail(paymentUnavailable('fixture outage'))
      : Effect.succeed(Option.fromUndefinedOr(fake.route));
  },
});

const read = (fake: FakeRoute, authMethod: 'api_key' | 'session' = 'api_key') => {
  const lookups: string[] = [];
  return handleProviderBindingRoute(
    { routeKey: ROUTE_KEY },
    {
      readKey: providerBindingRouteRead.descriptor.readKey,
      scope: tenantScope(authMethod),
      services: servicesOf(fake, lookups),
    },
  ).pipe(
    Effect.result,
    Effect.map((result) => ({ lookups, result })),
  );
};

type ReadOutcome = Effect.Success<ReturnType<typeof read>>['result'];
const failureTagOf = (result: ReadOutcome) => (Result.isFailure(result) ? result.failure._tag : 'Success');

describe('#1157 provider binding route Read handler', () => {
  it.effect('#1157 a retired binding still resolves to its binding, LE and the frozen operations', () =>
    Effect.gen(function* retiredResolves() {
      const { lookups, result } = yield* read({ route: retiredRoute });
      expect(lookups).toEqual([ROUTE_KEY]);
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success.evidence).toEqual({ resultCount: 1 });
        const answer = Schema.decodeUnknownSync(ProviderBindingRouteResponseSchema)(
          Schema.encodeSync(ProviderBindingRouteResponseSchema)(result.success.result),
        );
        expect(answer).toEqual({ ...retiredRoute, operations: PROVIDER_BINDING_ROUTE_OPERATIONS });
        // Each workload is named exactly once, with its one operation at schema version 1.
        expect(answer.operations.map((operation) => operation.workloadKey)).toEqual([
          'payment.provider-notification-ingress',
          'payment.provider-reconciliation',
        ]);
      }
    }),
  );

  it.effect('#1157 an unknown key (or another Tenant’s) is the typed not-found', () =>
    Effect.gen(function* unknownKey() {
      const { result } = yield* read({});
      expect(failureTagOf(result)).toBe('ReadHandlerNotFound');
    }),
  );

  it.effect('#1157 only an API-key integration principal is answered; an outage is unavailable', () =>
    Effect.gen(function* callerKinds() {
      const session = yield* read({ route: retiredRoute }, 'session');
      expect([failureTagOf(session.result), session.lookups]).toEqual(['ReadPermissionDenied', []]);
      for (const kind of ['human', 'agent'] as const) {
        const other = yield* read({ kind, route: retiredRoute });
        expect([failureTagOf(other.result), other.lookups]).toEqual(['ReadPermissionDenied', []]);
      }
      const outage = yield* read({ route: 'unavailable' });
      expect(failureTagOf(outage.result)).toBe('ReadHandlerUnavailable');
    }),
  );
});

/** An intent source that resolves every request to its Tenant scope and holds no grant cells. */
const authorityFor: AccessEnforcementPorts['intent']['authorityFor'] = () => ({
  readCells: () => Effect.succeed([]),
  readConnection: () => Effect.succeed(Option.none()),
  readScope: (query) =>
    Effect.succeed(
      Option.some({
        deadlines: [],
        holderDeadlines: [],
        scope: { _tag: 'TenantContext', tenantId: query.tenantId },
        scopeId: AccessScopeIdSchema.make('77777777-7777-4777-8777-777777777777'),
        tenantId: query.tenantId,
      }),
    ),
  readTeamIds: () => Effect.succeed([]),
});

/** The real Core access decision for this Read's carrier, over the caller's kind and bound workloads (O73). */
const decide = (kind: AccessPrincipalKind, boundKeys: readonly string[]) => {
  const ports: AccessEnforcementPorts = {
    ...inertAccessEnforcementPorts(),
    intent: { authorityFor },
    principalKinds: { readKind: () => Effect.succeed(Option.some(kind)) },
    workloadBindings: {
      // The workload is registered for the company the call runs in (D6).
      readWorkloadAuthority: (query) =>
        Effect.succeed({
          activeCompanyIds: new Set(
            query.scope.legalEntityId === undefined ? [] : [LegalEntityIdSchema.make(query.scope.legalEntityId)],
          ),
          workloadKeys: new Set(boundKeys),
        }),
    },
  };
  const gate = bindAccessGate(
    makeAccessDecisionService({
      authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
      workloadBindings: ports.workloadBindings,
    }),
    ports,
  );
  return gate
    .decide({
      carrier: providerBindingRouteRead.descriptor,
      legalEntityScope: providerBindingRouteRead.descriptor.legalEntityScope,
      now: new Date('2026-11-13T09:00:00Z'),
      scope: tenantScope('api_key'),
    })
    .pipe(Effect.map((decision) => [decision.outcome, decision.reasons.map((reason) => reason.code)]));
};

describe('#1157 / #1159 Core admission of the route Read', () => {
  it('#1157 the Read is workload-only, Tenant scoped and takes no company', () => {
    const { descriptor } = providerBindingRouteRead;
    expect(descriptor.legalEntityScope).toBe('forbidden');
    expect(descriptor.accessDeclaration).toBeUndefined();
    expect(descriptor.accessWorkload?.workloads).toEqual([
      'payment.provider-notification-ingress',
      'payment.provider-reconciliation',
    ]);
  });

  it.effect(
    '#1159 a human caller is workload_only, an agent is refused, an unbound integration is workload_unbound',
    () =>
      Effect.gen(function* admissions() {
        expect(yield* decide('human', ['payment.provider-notification-ingress'])).toEqual([
          'DENIED',
          ['deny.workload_only'],
        ]);
        // An agent is refused before the workload carrier is even considered.
        expect(yield* decide('agent', ['payment.provider-reconciliation'])).toEqual([
          'DENIED',
          ['deny.agent_forbidden'],
        ]);
        expect((yield* decide('integration', []))[1]).toEqual(['deny.workload_unbound']);
        expect((yield* decide('integration', ['payment.source-ingress']))[1]).toEqual(['deny.workload_unbound']);
        expect((yield* decide('integration', ['payment.provider-notification-ingress']))[0]).toBe('ALLOWED');
        expect((yield* decide('integration', ['payment.provider-reconciliation']))[0]).toBe('ALLOWED');
      }),
  );
});
