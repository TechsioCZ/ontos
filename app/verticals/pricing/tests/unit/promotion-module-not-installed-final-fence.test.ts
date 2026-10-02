import {
  ActiveApplicationCompositionSnapshotSchema,
  ActiveApplicationCompositionUnavailableError,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import type { PricingOwnerMaterialEvidenceFenceGatewayRequest as PricingTypedOwnerFenceRequest } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingDecision } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PricingOwnerMaterialEvidenceFenceGatewayUnavailable } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import type { PricingOwnerMaterialEvidenceFenceGatewayRequest } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { makePromotionModuleNotInstalledFinalFenceGateway } from '../../src/integrations/promotion-module-not-installed-final-fence.ts';
import { makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

const revision = 'a'.repeat(64);
const observedAt = '2026-09-28T12:00:00.000Z';
const evaluatedAt = '2026-09-28T12:00:10.000Z';
const validUntil = '2026-09-28T12:01:00.000Z';

const promotionModule = {
  allowedContributions: [],
  contract: { sha256: 'b'.repeat(64), url: 'https://promotion.example.test/contract.json' },
  dependencies: [],
  deployment: { appId: 'promotion', buildMarker: 'promotion-build-1' },
  federation: {
    execution: 'browser' as const,
    exposes: [],
    manifest: { sha256: 'c'.repeat(64), url: 'https://promotion.example.test/mf-manifest.json' },
    remoteName: 'promotion',
  },
  moduleId: 'commerce.promotion',
  publicContract: { id: 'commerce.promotion', sha256: 'd'.repeat(64), version: '1' },
  requiredCoreCapabilities: [],
  requiredShellAbi: { id: 'ontos.shell-contributions', version: '1' },
  sharedSingletons: [],
};

const snapshot = (
  modules: readonly (typeof promotionModule)[] = [],
  observed = observedAt,
  until = validUntil,
): ActiveApplicationCompositionSnapshot =>
  Schema.decodeSync(ActiveApplicationCompositionSnapshotSchema)({
    composition: {
      modules,
      revision,
      schemaVersion: '1',
      shell: {
        contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
        coreCapabilities: [],
        sharedSingletons: [],
      },
    },
    observedAt: observed,
    validUntil: until,
  });

const candidateRef = 'candidate:790:promotion-absence';
const selectedPromotionExpectation = {
  currentFacts: [],
  evidenceObservedAt: observedAt,
  evidenceVerificationRef: 'promotion-proof:790',
  family: 'PROMOTION' as const,
  ownerModuleId: 'commerce.promotion' as const,
  ownerRootRef: 'promotion-root:790',
  ownerSetRevisionRef: 'promotion-revision:790',
  predicateRef: 'promotion-predicate:790',
  tenantId: '10000000-0000-4000-8000-000000000001',
};

const verificationContext = (decision: PricingDecision): Omit<PricingTypedOwnerFenceRequest, 'sources'> => ({
  candidateRef,
  decision,
  effectiveAt: decision.operationTime,
  evaluatedAt,
  requestedAt: observedAt,
  subject: {
    guestEvidenceRef: 'guest-evidence:promotion-absence:790',
    guestSessionRef: 'guest-session:promotion-absence:790',
    kind: 'GUEST',
  },
});

const makeVerifyRequest = Effect.gen(function* makePromotionVerifyRequest() {
  const { compositionRequest } = yield* makeIssue779Scenario();
  return {
    candidateRef,
    sources: [],
    verificationContext: verificationContext(compositionRequest.decision),
  } satisfies PricingOwnerMaterialEvidenceFenceGatewayRequest;
});

describe('Promotion module-not-installed final fence (#790)', () => {
  it.effect('proves only the source-free path against the governed active composition revision', () => {
    const gateway = makePromotionModuleNotInstalledFinalFenceGateway(Effect.succeed(snapshot()));
    return Effect.gen(function* provesAbsentModule() {
      const verifyRequest = yield* makeVerifyRequest;
      const verification = yield* gateway.verifyOpaqueProofsAgainstCurrentState(verifyRequest);
      expect(verification).toEqual({ completedAt: observedAt, observations: [] });

      const generation = yield* gateway.confirmObservedGenerationsThrough({
        candidateRef: verifyRequest.candidateRef,
        observations: verification.observations,
        through: evaluatedAt,
        typedSources: [],
      });
      expect(generation).toEqual({ confirmations: [], verifiedThrough: '2026-09-28T12:00:59.999Z' });
    });
  });

  it.effect('fails closed when Promotion is installed without its public replay endpoint', () => {
    const gateway = makePromotionModuleNotInstalledFinalFenceGateway(Effect.succeed(snapshot([promotionModule])));
    return Effect.gen(function* rejectsInstalledPromotion() {
      const verifyRequest = yield* makeVerifyRequest;
      const failure = yield* gateway.verifyOpaqueProofsAgainstCurrentState(verifyRequest).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PricingOwnerMaterialEvidenceFenceGatewayUnavailable);
      expect(failure.reason).toMatch(/installed.*published Promotion owner endpoint/iu);
      expect(failure).not.toHaveProperty('observations');
    });
  });

  it.effect('never reclassifies selected Promotion material as a module-absence proof', () => {
    const gateway = makePromotionModuleNotInstalledFinalFenceGateway(Effect.succeed(snapshot()));
    return Effect.gen(function* rejectsSelectedMaterial() {
      const verifyRequest = yield* makeVerifyRequest;
      const failure = yield* gateway
        .verifyOpaqueProofsAgainstCurrentState({
          ...verifyRequest,
          sources: [selectedPromotionExpectation],
        })
        .pipe(Effect.flip);
      expect(failure.reason).toMatch(/cannot verify selected Promotion/iu);
      expect(failure).not.toHaveProperty('completedAt');
    });
  });

  it.effect('fails closed for unavailable, future-observed, and expired composition authority', () =>
    Effect.gen(function* rejectsUntrustedCompositionEvidence() {
      const verifyRequest = yield* makeVerifyRequest;
      const unavailableGateway = makePromotionModuleNotInstalledFinalFenceGateway(
        Effect.fail(
          new ActiveApplicationCompositionUnavailableError({ reason: 'Active revision source is unavailable' }),
        ),
      );
      const unavailableFailure = yield* unavailableGateway
        .verifyOpaqueProofsAgainstCurrentState(verifyRequest)
        .pipe(Effect.flip);
      expect(unavailableFailure.reason).toMatch(/authoritative.*unavailable/iu);

      for (const staleSnapshot of [
        snapshot([], '2026-09-28T12:00:11.000Z', validUntil),
        snapshot([], observedAt, evaluatedAt),
      ]) {
        const gateway = makePromotionModuleNotInstalledFinalFenceGateway(Effect.succeed(staleSnapshot));
        const failure = yield* gateway.verifyOpaqueProofsAgainstCurrentState(verifyRequest).pipe(Effect.flip);
        expect(failure.reason).toMatch(/not Current/iu);
      }
    }),
  );
});
