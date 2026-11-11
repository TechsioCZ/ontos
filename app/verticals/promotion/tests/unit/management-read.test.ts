import {
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { readPromotionsRead } from '../../src/api/read-promotions.read.ts';
import { readVouchersRead } from '../../src/api/read-vouchers.read.ts';
import { promotionRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const promotionId = '22222222-2222-4222-8222-222222222222';
const voucherId = '33333333-3333-4333-8333-333333333333';
const compositionRevision = 'a'.repeat(64);
const principal = trustVerifiedGatewayPrincipalContext(
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: voucherId,
    authContextRef: 'promotion-read-session',
    authMethod: 'session',
    legalEntityId: promotionId,
    principalId: promotionId,
    tenantId,
  }),
  compositionRevision,
);
const scope = { ...principal, correlationId: 'management-read' };
const at = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-06T10:00:00Z'));
const meaning = {
  activation: 'AUTOMATIC',
  benefit: { kind: 'PERCENTAGE', percentage: '10' },
  displayName: 'Owned offer',
  effectivePeriod: { from: at.toISOString() },
  eligibility: { commercialScopes: [{ channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: promotionId }] },
  family: 'AUTOMATIC_CART',
  target: 'MERCHANDISE_CART',
};

// The public SQL harness preserves native SELECT column order through Object.values.
const auditColumns = {
  actionInvocationId: voucherId,
  actorPrincipalId: voucherId,
  reason: 'private audit reason',
  recordedAt: at.toISOString(),
};

describe('registered management read projections', () => {
  it.effect('runs the original owner factory and preserves safe records while dropping internal attribution', () =>
    Effect.gen(function* safePromotionRead() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        compositionRevision,
        executeOwnerQuery: ({ sql }) => {
          if (sql.startsWith('select "promotion_id" from "promotion"."promotion_drafts"')) {
            return Effect.succeed([{ id: promotionId }]);
          }
          if (sql.includes('from "promotion"."promotion_drafts"')) {
            return Effect.succeed([
              {
                meaning,
                predecessorPromotionId: null,
                promotionId,
                tenantId,
                updatedAt: at.toISOString(),
                version: 1,
                ...auditColumns,
              },
            ]);
          }
          if (
            sql.includes('from "promotion"."published_promotions"') ||
            sql.includes('from "promotion"."lifecycle_facts"')
          ) {
            return Effect.succeed([]);
          }
          return Effect.die(`Unexpected owner query: ${sql}`);
        },
        operationTime: at,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: promotionRegistration,
        scope,
      });
      const result = yield* harness.runtime.runRead({
        input: {},
        principal,
        registration: readPromotionsRead,
        transport: { correlationId: scope.correlationId },
      });
      expect(result.promotions).toHaveLength(1);
      expect(result.promotions[0]?.meaning.displayName).toBe('Owned offer');
      expect(result.promotions[0]).not.toHaveProperty('actorPrincipalId');
      expect(result.promotions[0]).not.toHaveProperty('actionInvocationId');
      expect(result.promotions[0]).not.toHaveProperty('reason');
      expect(JSON.stringify(result)).not.toContain('private audit reason');
      expect(harness.snapshot().evidenceWrites).toBe(1);
      const [query] = harness.snapshot().ownerQueries;
      expect(query?.params).toContain(principal.legalEntityId);
      expect(query?.params).toContain(tenantId);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('returns only safe Voucher identities and applies the requested exact identity', () =>
    Effect.gen(function* safeVoucherRead() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        compositionRevision,
        executeOwnerQuery: () => Effect.succeed([{ disabled: true, promotionId, voucherId }]),
        operationTime: at,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: promotionRegistration,
        scope,
      });
      const result = yield* harness.runtime.runRead({
        input: { voucherId },
        principal,
        registration: readVouchersRead,
        transport: { correlationId: scope.correlationId },
      });
      expect(result).toEqual({ vouchers: [{ disabled: true, promotionId, voucherId }] });
      expect(result.vouchers[0]).not.toHaveProperty('normalizedCode');
      expect(result.vouchers[0]).not.toHaveProperty('actorPrincipalId');
      const absent = yield* harness.runtime.runRead({
        input: { voucherId: tenantId },
        principal,
        registration: readVouchersRead,
        transport: { correlationId: scope.correlationId },
      });
      expect(absent.vouchers).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('does not execute owner queries when Current management permission is denied', () =>
    Effect.gen(function* refusedRead() {
      const harness = yield* makeReadTestHarness({
        access: 'denied',
        compositionRevision,
        executeOwnerQuery: () => Effect.die('Denied read reached owner data'),
        operationTime: at,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: promotionRegistration,
        scope,
      });
      const error = yield* Effect.flip(
        harness.runtime.runRead({
          input: {},
          principal,
          registration: readVouchersRead,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
