import type { OperationalScope, ScopedRoutineInvoker } from '@app/core-runtime';
import { PersistenceFailure, ReadHandlerUnavailable } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  StorefrontApplicationsRequestSchema,
  StorefrontApplicationsResponseSchema,
} from '../../shared/apis/storefront-applications.ts';
import { handleStorefrontApplications } from '../../src/api/storefront-applications.read.ts';
import { storefrontApplicationsPersistence } from '../../src/persistence/storefront-applications-persistence.ts';
import type { StorefrontApplicationsPersistence } from '../../src/persistence/storefront-applications-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const request = Schema.decodeSync(StorefrontApplicationsRequestSchema)({ at: '2026-11-01T10:00:00.000Z' });
const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'storefront-registry-list',
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId,
};
type RoutinePayload = typeof StorefrontApplicationsResponseSchema.Encoded;
const ref = (
  resourceId: string,
  ownerTenantId = tenantId,
): RoutinePayload['applications'][number]['storefrontApplicationRef'] => ({
  moduleId: 'commerce.storefront-registry',
  resourceId,
  resourceType: 'commerce.storefront-registry.storefront-application',
  tenantId: ownerTenantId,
});
const routinePayload = (ownerTenantId = tenantId): RoutinePayload => ({
  applications: [
    {
      allowedChannels: ['B2C', 'B2B'],
      effectiveInterval: { effectiveFrom: '2026-09-01T00:00:00.000Z' },
      lifecycle: 'ACTIVE',
      revision: 2,
      storefrontAppId: 'akros-storefront',
      storefrontApplicationRef: ref('33333333-3333-4333-8333-333333333333', ownerTenantId),
    },
    {
      allowedChannels: ['B2C'],
      effectiveInterval: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: '2027-01-01T00:00:00.000Z' },
      lifecycle: 'SUSPENDED',
      revision: 1,
      storefrontAppId: 'kavarna-doma-eshop',
      storefrontApplicationRef: ref('44444444-4444-4444-8444-444444444444'),
    },
  ],
  observedAt: '2026-11-01T10:00:00.000Z',
});
const invoker = (payload: RoutinePayload, calls: unknown[] = []): ScopedRoutineInvoker => ({
  invoke: (routine, values) => {
    calls.push(values);
    return Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ payload }]));
  },
});
const context = (services: StorefrontApplicationsPersistence) => ({
  readKey: 'commerce.storefront-registry.api.storefront-applications',
  scope,
  services,
});

describe('Storefront applications governed owner read', () => {
  it.effect('lists the Tenant registrations from the owner routine and counts them as evidence', () =>
    Effect.gen(function* listRegistrations() {
      const calls: unknown[] = [];
      const output = yield* handleStorefrontApplications(
        request,
        context(storefrontApplicationsPersistence(invoker(routinePayload(), calls), tenantId)),
      );
      expect(calls).toEqual([[{ at: '2026-11-01T10:00:00.000Z' }]]);
      expect(output.evidence.resultCount).toBe(2);
      expect(output.result.applications.map((application) => application.storefrontAppId)).toEqual([
        'akros-storefront',
        'kavarna-doma-eshop',
      ]);
      expect(Schema.is(StorefrontApplicationsResponseSchema)(output.result)).toBe(true);
    }),
  );

  it.effect('rejects non-canonical instants, foreign Tenant rows and a missing routine row as unavailable', () =>
    Effect.gen(function* failClosed() {
      const nonCanonical: RoutinePayload = { ...routinePayload(), observedAt: '2026-11-01T11:00:00+01:00' };
      for (const payload of [nonCanonical, routinePayload('55555555-5555-4555-8555-555555555555')]) {
        const failure = yield* Effect.flip(storefrontApplicationsPersistence(invoker(payload), tenantId).list(request));
        expect(failure).toBeInstanceOf(PersistenceFailure);
      }
      const empty: ScopedRoutineInvoker = { invoke: () => Effect.succeed([]) };
      expect(yield* Effect.flip(storefrontApplicationsPersistence(empty, tenantId).list(request))).toBeInstanceOf(
        PersistenceFailure,
      );
    }),
  );

  it.effect('maps owner persistence failures onto the governed unavailable read failure', () =>
    Effect.gen(function* mapUnavailable() {
      const services: StorefrontApplicationsPersistence = {
        list: () => Effect.fail(new PersistenceFailure({ cause: 'fixture', reason: 'fixture' })),
      };
      const failure = yield* Effect.flip(handleStorefrontApplications(request, context(services)));
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );
});
