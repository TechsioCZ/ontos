import type { OperationalScope } from '@app/core-runtime';
import { ReadHandlerUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { MarketSubjectRestrictionsCurrentRequestSchema } from '../../shared/apis/market-subject-restrictions-current.ts';
import {
  marketSubjectRestrictionsCurrentPermissionTarget,
  readCurrentMarketSubjectRestrictionsFromServices,
} from '../../src/api/market-subject-restrictions-current.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2030-06-01T12:00:00.000Z';
const retailProfileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const counterpartyProfileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;

const scope = { tenantId };
const operationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '44444444-4444-4444-8444-444444444444',
    authContextRef: 'better-auth-session:subject-restrictions-test',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'subject-restrictions-test',
} satisfies OperationalScope;

describe('Current Market subject restrictions owner read', () => {
  it.effect('issues fixed Retail seller and B2C evidence from the Current owner profile', () =>
    Effect.gen(function* retailRestrictions() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const input = Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentRequestSchema)({
        subject: { kind: 'RETAIL_PROFILE', profileRef: retailProfileRef },
      });
      const result = yield* readCurrentMarketSubjectRestrictionsFromServices(input, scope, {
        readRestrictionProfile: () =>
          Effect.succeed({
            observation: { profileRef: retailProfileRef, revision: 7, sellerRef, state: 'ACTIVE' },
            outcome: 'PROFILE_AVAILABLE',
          }),
      });
      expect(result).toMatchObject({
        channelConstraint: { allowedChannels: ['B2C'], kind: 'ALLOWED_CHANNELS' },
        decision: 'ALLOWED',
        marketConstraint: { kind: 'ANY_MARKET' },
        outcome: 'SUBJECT_RESTRICTIONS_CURRENT',
        sellerConstraint: { kind: 'FIXED_SELLER', sellerRef },
      });
      if (result.outcome === 'SUBJECT_RESTRICTIONS_CURRENT') {
        expect(DateTime.formatIso(result.observedAt)).toBe(observedAt);
        expect(result.ownerRevision).toContain('revision-7:state-active');
        expect(result.completenessEvidence.ownerRevision).toBe(result.ownerRevision);
        expect(JSON.stringify(result)).not.toContain(operationalScope.principalId);
      }
    }),
  );

  it.effect('issues the Counterparty seller set only after durable Counterparty identity matches', () =>
    Effect.gen(function* counterpartyRestrictions() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const input = Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentRequestSchema)({
        subject: { counterpartyRef, kind: 'COUNTERPARTY', profileRef: counterpartyProfileRef },
      });
      const services = {
        readRestrictionProfile: () =>
          Effect.succeed({
            observation: {
              counterpartyResourceId: counterpartyRef.resourceId,
              profileRef: counterpartyProfileRef,
              revision: 3,
              sellerRef,
              state: 'ACTIVE' as const,
            },
            outcome: 'PROFILE_AVAILABLE' as const,
          }),
      };
      const result = yield* readCurrentMarketSubjectRestrictionsFromServices(input, scope, services);
      expect(result).toMatchObject({
        channelConstraint: { allowedChannels: ['B2B'] },
        outcome: 'SUBJECT_RESTRICTIONS_CURRENT',
        sellerConstraint: { kind: 'ALLOWED_SELLERS', sellerRefs: [sellerRef] },
      });

      const mismatch = yield* readCurrentMarketSubjectRestrictionsFromServices(input, scope, {
        readRestrictionProfile: () =>
          Effect.succeed({
            observation: {
              counterpartyResourceId: 'another-counterparty',
              profileRef: counterpartyProfileRef,
              revision: 3,
              sellerRef,
              state: 'ACTIVE' as const,
            },
            outcome: 'PROFILE_AVAILABLE' as const,
          }),
      });
      expect(mismatch.outcome).toBe('SUBJECT_RESTRICTIONS_UNVERIFIABLE');
    }),
  );

  it.effect('keeps owner unavailability separate from a known denied lifecycle', () =>
    Effect.gen(function* unavailableAndDenied() {
      yield* TestClock.setTime(Date.parse(observedAt));
      const input = Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentRequestSchema)({
        subject: { kind: 'RETAIL_PROFILE', profileRef: retailProfileRef },
      });
      const failure = new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'fixture unavailable' });
      const unavailable = yield* readCurrentMarketSubjectRestrictionsFromServices(input, scope, {
        readRestrictionProfile: () => Effect.fail(failure),
      });
      expect(unavailable).toMatchObject({ outcome: 'SUBJECT_RESTRICTIONS_UNAVAILABLE', retryable: true });
      const denied = yield* readCurrentMarketSubjectRestrictionsFromServices(input, scope, {
        readRestrictionProfile: () =>
          Effect.succeed({
            observation: { profileRef: retailProfileRef, revision: 8, sellerRef, state: 'SUSPENDED' },
            outcome: 'PROFILE_AVAILABLE',
          }),
      });
      expect(denied).toMatchObject({ decision: 'DENIED', outcome: 'SUBJECT_RESTRICTIONS_CURRENT' });
    }),
  );

  it('authorizes against exact Retail Profile or Counterparty owner targets', () => {
    const retail = Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentRequestSchema)({
      subject: { kind: 'RETAIL_PROFILE', profileRef: retailProfileRef },
    });
    const counterparty = Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentRequestSchema)({
      subject: { counterpartyRef, kind: 'COUNTERPARTY', profileRef: counterpartyProfileRef },
    });
    expect(marketSubjectRestrictionsCurrentPermissionTarget(retail, operationalScope)).toMatchObject({
      businessPermission: { permission: 'retail.profile.read', target: { profileId: retailProfileRef.resourceId } },
    });
    expect(marketSubjectRestrictionsCurrentPermissionTarget(counterparty, operationalScope)).toMatchObject({
      businessPermission: {
        permission: 'counterparty.profile.read',
        target: { counterpartyId: counterpartyRef.resourceId },
      },
    });
  });
});
