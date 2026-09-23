import type { OperationalScope } from '@app/core-runtime';
import { ReadPermissionDenied } from '@app/core-runtime';
import {
  CurrentStorefrontApplicationRequestSchema,
  CurrentStorefrontApplicationResponseSchema,
} from '@app/storefront-registry-contracts';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';
import { handleCurrentStorefrontApplication } from '../../src/api/current-storefront-application.read.ts';
import type {
  CurrentStorefrontApplicationPersistence,
  CurrentStorefrontApplicationSnapshot,
} from '../../src/persistence/current-storefront-application-persistence.ts';
import { StorefrontRegistryPersistenceUnavailable } from '../../src/persistence/current-storefront-application-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const request = Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({
  effectiveAt: '2026-09-22T10:00:00.000Z',
  requestedChannel: 'B2C',
  storefrontAppId: 'shop-cz',
  tenantId,
});
const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'storefront-registry-read',
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId,
};
const active: CurrentStorefrontApplicationSnapshot = {
  allowedChannels: ['B2C', 'B2B'],
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-10-01T00:00:00.000Z',
  generation: 7,
  lifecycle: 'ACTIVE',
  observedAt: '2026-09-22T09:59:59.000Z',
  revision: 3,
};
const persistence = (
  snapshot: Option.Option<CurrentStorefrontApplicationSnapshot>,
): CurrentStorefrontApplicationPersistence => ({
  load: () => Effect.succeed({ generation: 7, observedAt: active.observedAt, snapshot }),
});
const context = (services: CurrentStorefrontApplicationPersistence, scopeOverride: OperationalScope = scope) => ({
  readKey: 'commerce.storefront-registry.api.current-storefront-application',
  scope: scopeOverride,
  services,
});

describe('Current Storefront Application governed owner read', () => {
  it.effect('returns owner revision, currentness boundary, and channel applicability evidence', () =>
    Effect.gen(function* returnCurrentApplicationEvidence() {
      const output = yield* Option.some(active).pipe(persistence, context, (readContext) =>
        handleCurrentStorefrontApplication(request, readContext),
      );
      expect(output.result).toEqual({
        ...request,
        allowedChannels: ['B2C', 'B2B'],
        effectiveInterval: {
          effectiveFrom: active.effectiveFrom,
          effectiveTo: active.effectiveTo,
        },
        lifecycle: 'ACTIVE',
        nextApplicabilityBoundary: active.effectiveTo,
        observedAt: active.observedAt,
        outcome: 'CURRENT',
        ownerRevision: 'storefront-application:shop-cz:r3:g7',
      });
      expect(Schema.is(CurrentStorefrontApplicationResponseSchema)(output.result)).toBe(true);
      expect(output.evidence.resultCount).toBe(1);
    }),
  );

  it.effect('distinguishes missing, lifecycle, channel, interval, and owner-unavailable outcomes', () =>
    Effect.gen(function* distinguishOwnerReadOutcomes() {
      const missing = yield* Option.none<CurrentStorefrontApplicationSnapshot>().pipe(
        persistence,
        context,
        (readContext) => handleCurrentStorefrontApplication(request, readContext),
      );
      expect(missing.result.outcome).toBe('NOT_FOUND');

      const inactive = yield* Option.some({ ...active, lifecycle: 'SUSPENDED' } as const).pipe(
        persistence,
        context,
        (readContext) => handleCurrentStorefrontApplication(request, readContext),
      );
      expect(inactive.result).toMatchObject({ lifecycle: 'SUSPENDED', outcome: 'NOT_CURRENT' });

      const channel = yield* Option.some({ ...active, allowedChannels: ['B2B'] } as const).pipe(
        persistence,
        context,
        (readContext) => handleCurrentStorefrontApplication(request, readContext),
      );
      expect(channel.result).toMatchObject({ allowedChannels: ['B2B'], outcome: 'CHANNEL_NOT_ALLOWED' });

      const interval = yield* Option.some({ ...active, effectiveFrom: '2026-09-23T00:00:00.000Z' }).pipe(
        persistence,
        context,
        (readContext) => handleCurrentStorefrontApplication(request, readContext),
      );
      expect(interval.result.outcome).toBe('UNVERIFIABLE');

      const unavailable: CurrentStorefrontApplicationPersistence = {
        load: () =>
          Effect.fail(
            new StorefrontRegistryPersistenceUnavailable({
              code: 'storefront_registry_persistence_unavailable',
              reason: 'fixture',
            }),
          ),
      };
      const ownerUnavailable = yield* handleCurrentStorefrontApplication(request, context(unavailable));
      expect(ownerUnavailable.result).toMatchObject({ outcome: 'UNAVAILABLE', retryable: true });
    }),
  );

  it.effect('rejects a cross-Tenant request before owner persistence access', () =>
    Effect.gen(function* rejectCrossTenantRequest() {
      const calls: string[] = [];
      const services: CurrentStorefrontApplicationPersistence = {
        load: () => {
          calls.push('load');
          return Effect.succeed({ generation: 0, observedAt: active.observedAt, snapshot: Option.none() });
        },
      };
      const failure = yield* handleCurrentStorefrontApplication(
        request,
        context(services, { ...scope, tenantId: '33333333-3333-4333-8333-333333333333' }),
      ).pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(calls).toHaveLength(0);
    }),
  );
});
