import {
  PricingPurchaseContextVerificationEvidenceSchema,
  PricingPurchaseContextVerificationRequestSchema,
} from '../../shared/apis/pricing-purchase-context-verification.ts';
import {
  PricingPurchaseContextOwnerUnavailable,
  PricingPurchaseContextOwnerUnverifiable,
  PricingPurchaseContextVerification,
  makePricingPurchaseContextVerificationServices,
  pricingPurchaseContextOwnerAuthorityUnavailableLive,
  pricingPurchaseContextVerificationLive,
} from '../../src/services/pricing-purchase-context-owner-authority.ts';
import type {
  PricingPurchaseContextOwnerAuthorityPort,
  PricingPurchaseContextOwnerObservation,
} from '../../src/services/pricing-purchase-context-owner-authority.ts';
import { Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const tenantId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const callingPrincipalId = principalId;
const storefrontWorkloadPrincipalId = '30000000-0000-4000-8000-000000000002';
const legalEntityId = '40000000-0000-4000-8000-000000000001';
const operationTime = '2026-09-28T10:00:00.000Z';
const observedAt = '2026-09-28T10:00:01.000Z';
const contextRef = 'commerce.purchase-context:790';
const contextRevision = 'commerce.purchase-context:790:7';
const channelId = 'commerce-channel:web-cz';
const marketId = 'commerce-market:cz';
const profileResourceId = '50000000-0000-4000-8000-000000000001';

const profileSubject = (resourceId = profileResourceId) => ({
  authorizationSubject: { kind: 'RETAIL' as const },
  kind: 'PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId,
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId,
  },
});

const request = Schema.decodeUnknownSync(PricingPurchaseContextVerificationRequestSchema)({
  actor: { kind: 'AUTHENTICATED_CUSTOMER', principalId },
  operationTime,
  purchasingContext: { channelId, contextRef, contextRevision, marketId, sellingLegalEntityId: legalEntityId },
  subject: profileSubject(),
  tenantId,
});

const evidenceFor = (ownerRevisionRef = contextRevision) =>
  Schema.decodeUnknownSync(PricingPurchaseContextVerificationEvidenceSchema)({
    currentness: {
      evaluatedAt: operationTime,
      observedAt,
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: null,
    },
    ownerRef: contextRef,
    ownerRevisionRef,
    subjectAuthority: {
      actorPrincipalId: principalId,
      kind: 'PROFILE',
      partyAuthorityRef: 'party.registry.party:790',
      partyAuthorityRevisionRef: 'party.registry.party:790:4',
      subject: profileSubject(),
      subjectAuthorityRef: `commerce.customer-context.profile:${profileResourceId}`,
      subjectAuthorityRevisionRef: 'commerce.customer-context.profile:790:12',
    },
    verificationRef: 'commerce.customer-context.purchase-context-verification:790',
    verifiedScope: { channelId, legalEntityId, marketId, tenantId },
  });

const observationFor = (
  overrides: Partial<PricingPurchaseContextOwnerObservation> = {},
): PricingPurchaseContextOwnerObservation => ({
  actor: request.actor,
  evidence: evidenceFor(),
  legalEntityId,
  purchasingContext: request.purchasingContext,
  subject: request.subject,
  tenantId,
  ...overrides,
});

const scope = { callingPrincipalId, legalEntityId, tenantId };

describe('Pricing Purchase Context owner authority #790', () => {
  it.effect(
    'returns lossless owner evidence only for the exact trusted Profile, Party, context revision, and time',
    () => {
      const calls: unknown[] = [];
      const authority: PricingPurchaseContextOwnerAuthorityPort = {
        readCurrent: (input) => {
          calls.push(input);
          return Effect.succeed(Option.some(observationFor()));
        },
      };

      return Effect.gen(function* exactAuthority() {
        const result = yield* makePricingPurchaseContextVerificationServices(authority).verify(request, scope);

        expect(result).toEqual({ evidence: evidenceFor(), outcome: 'PURCHASE_CONTEXT_VERIFIED', request });
        expect(calls).toEqual([
          {
            callingPrincipalId,
            legalEntityId,
            request,
            trustedTenantId: tenantId,
          },
        ]);
        expect(result.outcome === 'PURCHASE_CONTEXT_VERIFIED' && result.evidence.currentness.observedAt).toBe(
          observedAt,
        );
      });
    },
  );

  it.effect('rejects cross-Profile authority and an arbitrary Guest without converting either into absence', () => {
    const crossProfile: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.succeed(
          Option.some(
            observationFor({
              subject: profileSubject('50000000-0000-4000-8000-000000000099'),
            }),
          ),
        ),
    };
    const arbitraryGuestRequest = Schema.decodeUnknownSync(PricingPurchaseContextVerificationRequestSchema)({
      ...request,
      actor: { kind: 'GUEST' },
      subject: {
        guestEvidenceRef: 'guest-evidence:attacker',
        guestSessionRef: 'guest-session:attacker',
        kind: 'GUEST',
      },
    });
    const absentGuest: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () => Effect.succeedNone,
    };

    return Effect.gen(function* rejectClaims() {
      const profileResult = yield* makePricingPurchaseContextVerificationServices(crossProfile).verify(request, scope);
      const guestResult = yield* makePricingPurchaseContextVerificationServices(absentGuest).verify(
        arbitraryGuestRequest,
        scope,
      );

      expect(profileResult).toMatchObject({
        outcome: 'PURCHASE_CONTEXT_MISMATCH',
        reason: 'PROFILE_NOT_AUTHORIZED',
      });
      expect(guestResult).toMatchObject({
        outcome: 'PURCHASE_CONTEXT_MISMATCH',
        reason: 'GUEST_NOT_AUTHORIZED',
      });
    });
  });

  it.effect('rejects substitution when the authenticated caller is not the customer actor', () => {
    let calls = 0;
    const authority: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () => {
        calls += 1;
        return Effect.succeed(Option.some(observationFor()));
      },
    };

    return Effect.gen(function* rejectSubstitution() {
      const result = yield* makePricingPurchaseContextVerificationServices(authority).verify(request, {
        ...scope,
        callingPrincipalId: '30000000-0000-4000-8000-000000000099',
      });

      expect(result).toMatchObject({ outcome: 'PURCHASE_CONTEXT_MISMATCH', reason: 'TRUSTED_SCOPE_MISMATCH' });
      expect(calls).toBe(0);
    });
  });

  it.effect('verifies Guest evidence through the Guest authority path without a customer Principal', () => {
    const guestSubject = {
      guestEvidenceRef: 'guest-evidence:790',
      guestSessionRef: 'guest-session:790',
      kind: 'GUEST' as const,
    };
    const guestRequest = Schema.decodeUnknownSync(PricingPurchaseContextVerificationRequestSchema)({
      ...request,
      actor: { kind: 'GUEST' },
      subject: guestSubject,
    });
    const guestEvidence = Schema.decodeUnknownSync(PricingPurchaseContextVerificationEvidenceSchema)({
      ...evidenceFor(),
      subjectAuthority: {
        guestEvidenceAuthorityRef: 'commerce.customer-context.guest-evidence:790',
        guestSessionAuthorityRef: 'commerce.customer-context.guest-session:790',
        kind: 'GUEST',
        subject: guestSubject,
        subjectAuthorityRevisionRef: 'commerce.customer-context.guest-session:790:3',
      },
    });
    const authority: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.succeed(
          Option.some({
            actor: guestRequest.actor,
            evidence: guestEvidence,
            legalEntityId,
            purchasingContext: guestRequest.purchasingContext,
            subject: guestRequest.subject,
            tenantId,
          }),
        ),
    };

    return Effect.gen(function* verifyGuest() {
      const result = yield* makePricingPurchaseContextVerificationServices(authority).verify(guestRequest, {
        ...scope,
        callingPrincipalId: storefrontWorkloadPrincipalId,
      });
      expect(result).toEqual({ evidence: guestEvidence, outcome: 'PURCHASE_CONTEXT_VERIFIED', request: guestRequest });
      expect(JSON.stringify({ evidence: guestEvidence, request: guestRequest })).not.toContain(
        storefrontWorkloadPrincipalId,
      );
    });
  });

  it('rejects a synthetic Principal field from the Guest business contract', () => {
    expect(() =>
      Schema.decodeUnknownSync(PricingPurchaseContextVerificationRequestSchema, { onExcessProperty: 'error' })({
        ...request,
        actingPrincipalId: storefrontWorkloadPrincipalId,
        actor: { kind: 'GUEST' },
        subject: {
          guestEvidenceRef: 'guest-evidence:790',
          guestSessionRef: 'guest-session:790',
          kind: 'GUEST',
        },
      }),
    ).toThrow();
  });

  it.effect('rejects cross-Tenant and cross-Legal-Entity trusted scope before owner lookup', () => {
    let calls = 0;
    const authority: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () => {
        calls += 1;
        return Effect.succeed(Option.some(observationFor()));
      },
    };

    return Effect.gen(function* rejectForeignTrustedScope() {
      const services = makePricingPurchaseContextVerificationServices(authority);
      const wrongTenant = yield* services.verify(request, {
        ...scope,
        tenantId: '20000000-0000-4000-8000-000000000099',
      });
      const wrongLegalEntity = yield* services.verify(request, {
        ...scope,
        legalEntityId: '40000000-0000-4000-8000-000000000099',
      });

      expect(wrongTenant).toMatchObject({ outcome: 'PURCHASE_CONTEXT_MISMATCH', reason: 'TRUSTED_SCOPE_MISMATCH' });
      expect(wrongLegalEntity).toMatchObject({
        outcome: 'PURCHASE_CONTEXT_MISMATCH',
        reason: 'TRUSTED_SCOPE_MISMATCH',
      });
      expect(calls).toBe(0);
    });
  });

  it.effect('rejects owner state from another Legal Entity even when context and subject match', () => {
    const wrongLegalEntity: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.succeed(Option.some(observationFor({ legalEntityId: '40000000-0000-4000-8000-000000000099' }))),
    };

    return Effect.gen(function* rejectOtherLegalEntity() {
      const result = yield* makePricingPurchaseContextVerificationServices(wrongLegalEntity).verify(request, scope);
      expect(result).toMatchObject({ outcome: 'PURCHASE_CONTEXT_MISMATCH', reason: 'TRUSTED_SCOPE_MISMATCH' });
    });
  });

  it.effect('rejects owner evidence for another Channel or Market and never trusts request scope as proof', () => {
    const wrongChannel: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.succeed(
          Option.some(
            observationFor({
              purchasingContext: { ...request.purchasingContext, channelId: 'commerce-channel:other' },
            }),
          ),
        ),
    };
    const wrongMarketEvidence: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.succeed(
          Option.some(
            observationFor({
              evidence: {
                ...evidenceFor(),
                verifiedScope: { ...evidenceFor().verifiedScope, marketId: 'commerce-market:other' },
              },
            }),
          ),
        ),
    };

    return Effect.gen(function* rejectOtherCommerceScope() {
      expect(yield* makePricingPurchaseContextVerificationServices(wrongChannel).verify(request, scope)).toMatchObject({
        outcome: 'PURCHASE_CONTEXT_MISMATCH',
        reason: 'PURCHASING_CONTEXT_MISMATCH',
      });
      expect(
        yield* makePricingPurchaseContextVerificationServices(wrongMarketEvidence).verify(request, scope),
      ).toMatchObject({ outcome: 'PURCHASE_CONTEXT_MISMATCH', reason: 'TRUSTED_SCOPE_MISMATCH' });
    });
  });

  it.effect('distinguishes stale, unavailable, and unverifiable owner evidence', () => {
    const staleRevision = 'commerce.purchase-context:790:8';
    const stale: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.succeed(
          Option.some(
            observationFor({
              evidence: evidenceFor(staleRevision),
              purchasingContext: { ...request.purchasingContext, contextRevision: staleRevision },
            }),
          ),
        ),
    };
    const unavailable: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.fail(new PricingPurchaseContextOwnerUnavailable({ reason: 'Owner storage is unavailable' })),
    };
    const unverifiable: PricingPurchaseContextOwnerAuthorityPort = {
      readCurrent: () =>
        Effect.fail(new PricingPurchaseContextOwnerUnverifiable({ reason: 'Owner evidence cannot be verified' })),
    };

    return Effect.gen(function* typedFailures() {
      expect(yield* makePricingPurchaseContextVerificationServices(stale).verify(request, scope)).toMatchObject({
        currentContextRevision: staleRevision,
        outcome: 'PURCHASE_CONTEXT_STALE',
      });
      expect(yield* makePricingPurchaseContextVerificationServices(unavailable).verify(request, scope)).toMatchObject({
        outcome: 'PURCHASE_CONTEXT_UNAVAILABLE',
        reason: 'Owner storage is unavailable',
      });
      expect(yield* makePricingPurchaseContextVerificationServices(unverifiable).verify(request, scope)).toMatchObject({
        outcome: 'PURCHASE_CONTEXT_UNVERIFIABLE',
        reason: 'Owner evidence cannot be verified',
      });
    });
  });

  it.effect('keeps the missing production authority explicit and fail-closed', () =>
    Effect.gen(function* explicitProductionBlocker() {
      const verifier = yield* PricingPurchaseContextVerification;
      const result = yield* verifier.verify(request, scope);
      expect(result).toMatchObject({
        outcome: 'PURCHASE_CONTEXT_UNAVAILABLE',
        retryable: true,
      });
    }).pipe(
      Effect.provide(
        pricingPurchaseContextVerificationLive.pipe(Layer.provide(pricingPurchaseContextOwnerAuthorityUnavailableLive)),
      ),
    ),
  );
});
