import { AvailabilityCurrentnessPolicy } from '../../shared/domain/availability-currentness-policy-port.ts';
import { AvailabilityCurrentnessEvidence } from '../../shared/domain/availability-currentness-evidence-port.ts';
import { AvailabilityOwnerValidityVerifier } from '../../shared/domain/availability-currentness-owner-port.ts';
import type { AvailabilityOwnerVerificationRequest } from '../../shared/domain/availability-currentness-owner-port.ts';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { availabilityMaterialOwners } from '../../shared/domain/availability-currentness.ts';
import type {
  AvailabilityCurrentDecision,
  AvailabilityOwnerValidity,
} from '../../shared/domain/availability-currentness.ts';
import type { AvailabilityEvaluationInput } from '../../shared/domain/availability-decision.ts';
import { AvailabilityOwnerEvidenceUnavailable } from '../../shared/domain/availability-owner-ports.ts';
import {
  availabilityCurrentnessOwnerLayer,
  availabilityCurrentnessService,
} from '../../src/services/availability-currentness.service.ts';
import type { AvailabilityCurrentnessRequest } from '../../src/services/availability-currentness.service.ts';
import {
  makeChangedCurrentnessInput,
  materialPositionChanges,
  makeCurrentnessInput,
  makeRichExternalCurrentnessInput,
} from '../support/availability-currentness.ts';

const observedAt = '2026-10-05T12:00:00.000Z';
const later = '2026-10-05T12:07:00.000Z';
const base = makeCurrentnessInput(['3'], '2');
const request = (previous?: AvailabilityCurrentDecision): AvailabilityCurrentnessRequest => ({
  evaluatedAt: later,
  previous,
  representedInBundle: previous !== undefined,
  subject: base.subject,
  useBoundary: { kind: 'ORDER_COMMITMENT', requiredAt: later },
});
const proof = (
  evidence: AvailabilityEvaluationInput,
  useBoundary: AvailabilityCurrentnessRequest['useBoundary'],
  revision = 'R1',
): Extract<AvailabilityOwnerValidity, { readonly _tag: 'VALID' }> => ({
  _tag: 'VALID',
  coherence: 'OWNER_VERIFIED_COHERENT',
  evidence,
  materialEvidence: availabilityMaterialOwners.map((owner) => ({
    businessAt: observedAt,
    contractRef: `${owner}-currentness-contract`,
    evidenceRef: `${owner}-proof`,
    invalidationConditions: ['OWNER_MATERIAL_FACT_CHANGE', 'SET_INSERT_REMOVE_LIFECYCLE_SHARING_BINDING'],
    observedAt,
    owner,
    sourceRevisionRefs: [revision],

    validFrom: observedAt,
  })),
  subject: evidence.subject,
  useBoundary,
});
const run = (
  input: AvailabilityCurrentnessRequest,
  verify: typeof AvailabilityOwnerValidityVerifier.Service.verify,
  read: AvailabilityEvaluationInput = base,
  readCurrent: typeof AvailabilityCurrentnessEvidence.Service.readCurrent = () => Effect.succeed(read),
) =>
  availabilityCurrentnessService(input).pipe(
    Effect.provide(
      Layer.mergeAll(
        availabilityCurrentnessOwnerLayer,
        Layer.succeed(AvailabilityCurrentnessEvidence, { readCurrent }),
        Layer.succeed(AvailabilityOwnerValidityVerifier, { verify }),
      ),
    ),
  );
const valid = (input: AvailabilityOwnerVerificationRequest) => Effect.succeed(proof(input.evidence, input.useBoundary));

describe('owner-defined Availability Currentness and revalidation', () => {
  it.effect('integrates real policy and evaluator for 3 units supporting exact 2, but not 5', () =>
    Effect.gen(function* quantity() {
      const positive = yield* run(request(), valid);
      expect(positive.currentDecision.decision.outcome).toBe('AVAILABLE');
      const five = makeCurrentnessInput(['3'], '5');
      const negative = yield* run({ ...request(), subject: five.subject }, valid, five);
      expect(negative.currentDecision.decision.outcome).toBe('UNAVAILABLE');
      expect(positive.currentDecision.evaluatedAt).toBe(later);
      expect(positive.currentDecision.materialEvidence[0]?.businessAt).toBe(observedAt);
    }),
  );

  it.effect('keeps original immutable Bundle evidence when owner proves retained validity during source outage', () =>
    Effect.gen(function* retainedEvidence() {
      const previous = (yield* run(request(), valid)).currentDecision;
      const retained = yield* run(request(previous), valid, base, () =>
        Effect.fail(new AvailabilityOwnerEvidenceUnavailable({ owner: 'INVENTORY' })),
      );
      expect(retained.currentDecision.decision.outcome).toBe('AVAILABLE');
      expect(retained.bundleDisposition).toBe('UNCHANGED');
      expect(retained.originalDecision).toEqual(previous);
      expect(Object.isFrozen(retained.originalDecision?.decision.evidence)).toBe(true);
      expect(previous.decision.useBoundary.kind).toBe('ORDER_COMMITMENT');
    }),
  );

  it.effect('keeps represented owner evidence unchanged when its array order changes', () =>
    Effect.gen(function* ownerOrder() {
      const previous = (yield* run(request(), valid)).currentDecision;
      const result = yield* run(request(previous), (input) => {
        const unchanged = proof(input.evidence, input.useBoundary);
        return Effect.succeed({
          ...unchanged,
          materialEvidence: [...unchanged.materialEvidence.slice(2), ...unchanged.materialEvidence.slice(0, 2)],
        });
      });
      expect(result.bundleDisposition).toBe('UNCHANGED');
      expect(result.originalDecision).toEqual(previous);
      expect(previous.materialEvidence.map((entry) => entry.owner)).toEqual(availabilityMaterialOwners);
    }),
  );

  it.effect('resolves the exact policy before each bounded owner verification attempt', () =>
    Effect.gen(function* policyCoherence() {
      const stages: string[] = [];
      let attempts = 0;
      const result = yield* availabilityCurrentnessService(request()).pipe(
        Effect.provideService(AvailabilityCurrentnessPolicy, {
          resolveCurrent: (input) => {
            stages.push('policy');
            return Effect.succeed({ ...base.policy, subject: input.subject, useBoundary: input.useBoundary });
          },
        }),
        Effect.provide(
          Layer.mergeAll(
            availabilityCurrentnessOwnerLayer,
            Layer.succeed(AvailabilityCurrentnessEvidence, { readCurrent: () => Effect.succeed(base) }),
            Layer.succeed(AvailabilityOwnerValidityVerifier, {
              verify: (input) => {
                stages.push('verify');
                attempts += 1;
                expect(input.evidence.policy.useBoundary).toEqual(request().useBoundary);
                return Effect.succeed(
                  attempts === 1
                    ? { _tag: 'UNPROVEN' as const, reason: 'POLICY_OWNER_CHANGED' }
                    : proof(input.evidence, input.useBoundary, 'P2'),
                );
              },
            }),
          ),
        ),
      );
      expect(stages).toEqual(['policy', 'verify', 'policy', 'verify']);
      expect(result.currentDecision.currentness).toBe('OWNER_VERIFIED_CURRENT');
      expect(
        result.currentDecision.materialEvidence.find((entry) => entry.owner === 'AVAILABILITY_POLICY')
          ?.sourceRevisionRefs,
      ).toEqual(['P2']);
    }),
  );

  it.effect('never accepts expired owner validity or generic recent checkout as actual commitment authority', () =>
    Effect.gen(function* expiry() {
      const expired = yield* run(request(), (input) => {
        const response = proof(input.evidence, input.useBoundary);
        return Effect.succeed({
          ...response,
          materialEvidence: response.materialEvidence.map((entry) => ({ ...entry, validUntil: later })),
        });
      });
      expect(expired.currentDecision.decision.outcome).toBe('INDETERMINATE');
      expect(expired.currentDecision.currentness).toBe('INDETERMINATE');
      const recent = yield* run(request(), (input) =>
        Effect.succeed(proof(input.evidence, { kind: 'CHECKOUT_SUBMISSION', requiredAt: observedAt })),
      );
      expect(recent.currentDecision.decision.outcome).toBe('INDETERMINATE');
    }),
  );

  it.effect(
    'requires replacement for changed represented evidence even when quantity and AVAILABLE are unchanged',
    () =>
      Effect.gen(function* replacement() {
        const previous = (yield* run(request(), valid)).currentDecision;
        let attempts = 0;
        const result = yield* run(request(previous), (input) => {
          attempts += 1;
          return Effect.succeed(
            attempts === 1
              ? { _tag: 'INVALID' as const, reason: 'MATERIAL_OWNER_CHANGE' }
              : proof(input.evidence, input.useBoundary, 'R2'),
          );
        });
        expect(result.currentDecision.decision.outcome).toBe('AVAILABLE');
        expect(result.bundleDisposition).toBe('REPLACEMENT_REQUIRED');
        expect(result.originalDecision).toEqual(previous);
        expect(previous.materialEvidence[0]?.sourceRevisionRefs).toEqual(['R1']);
      }),
  );

  for (const change of materialPositionChanges) {
    it.effect(`discards invalid R1 and evaluates actual coherent R2 after ${change}`, () =>
      Effect.gen(function* changedSnapshot() {
        const previous = (yield* run(request(), valid)).currentDecision;
        const r2 = makeChangedCurrentnessInput(change);
        let verificationCount = 0;
        let readCount = 0;
        const result = yield* run(
          request(previous),
          (input) => {
            verificationCount += 1;
            if (verificationCount === 1) {
              expect(input.evidence).toEqual(previous.decision.evidence);
              return Effect.succeed({ _tag: 'INVALID' as const, reason: change });
            }
            expect(input.evidence.stockInput).toEqual(r2.stockInput);
            expect(input.evidence.ownerQualification.set).toEqual(r2.ownerQualification.set);
            expect(input.evidence.policy.useBoundary).toEqual(request().useBoundary);
            return Effect.succeed(proof(input.evidence, input.useBoundary, 'R2'));
          },
          r2,
          () => {
            readCount += 1;
            return Effect.succeed(r2);
          },
        );
        expect(readCount).toBe(1);
        expect(verificationCount).toBe(2);
        expect(result.currentDecision.decision.outcome).toBe(
          {
            BINDING: 'UNAVAILABLE',
            COMPLETENESS_LOST: 'INDETERMINATE',
            LIFECYCLE: 'UNAVAILABLE',
            POSITION_INSERT: 'AVAILABLE',
            POSITION_REMOVE: 'UNAVAILABLE',
            SHARING: 'UNAVAILABLE',
          }[change],
        );
        expect(result.currentDecision.decision.evidence.stockInput).toEqual(r2.stockInput);
        expect(result.currentDecision.decision.evidence.ownerQualification.set).toEqual(r2.ownerQualification.set);
        expect(result.bundleDisposition).toBe('REPLACEMENT_REQUIRED');
        expect(result.originalDecision).toEqual(previous);
        expect(result.originalDecision?.decision.outcome).toBe('AVAILABLE');
        expect(previous.materialEvidence[0]?.sourceRevisionRefs).toEqual(['R1']);
      }),
    );
  }

  it.effect('boundedly retries an unproven mixed-revision snapshot then returns truthful uncertainty', () =>
    Effect.gen(function* races() {
      let attempts = 0;
      const result = yield* run(request(), () => {
        attempts += 1;
        return Effect.succeed({ _tag: 'UNPROVEN' as const, reason: 'MIXED_R1_R2' });
      });
      expect(attempts).toBe(2);
      expect(result.currentDecision.decision.outcome).toBe('INDETERMINATE');
      expect(result.currentDecision.currentnessReasons).toContain('MIXED_R1_R2');
    }),
  );

  it.effect('source outage without owner-verifiable validity is neither a positive nor a negative', () =>
    Effect.gen(function* unavailable() {
      const result = yield* run(request(), () =>
        Effect.fail(new AvailabilityOwnerEvidenceUnavailable({ owner: 'INVENTORY' })),
      );
      expect(result.currentDecision.decision.outcome).toBe('INDETERMINATE');
      expect(result.currentDecision.currentnessReasons).toContain('OWNER_UNAVAILABLE');
    }),
  );

  it.effect('does not infer cross-context or completeness proof from successfully returned rows', () =>
    Effect.gen(function* coverage() {
      const result = yield* run(request(), (input) => {
        const response = proof(input.evidence, input.useBoundary);
        return Effect.succeed({
          ...response,
          subject: { ...response.subject, quantity: { ...response.subject.quantity, amount: '9' } },
        });
      });
      expect(result.currentDecision.decision.outcome).toBe('INDETERMINATE');
    }),
  );
  it.effect('detaches and freezes historical evidence before caller mutation', () =>
    Effect.gen(function* immutableHistory() {
      const mutable = makeCurrentnessInput(['3'], '2');
      const result = yield* run(request(), valid, mutable);
      expect(Reflect.set(mutable.subject.quantity, 'amount', '99')).toBe(true);
      expect(mutable.stockInput.positions).not.toBe(result.currentDecision.decision.evidence.stockInput.positions);
      expect(result.currentDecision.decision.subject.quantity.amount).toBe('2');
      expect(Object.isFrozen(result.currentDecision.decision.evidence.stockInput.positions)).toBe(true);
    }),
  );

  it.effect(
    'revalidates original evidence at commitment without rewriting informational history or reacting to unrelated revision change',
    () =>
      Effect.gen(function* revisionOnly() {
        const informational = yield* run({ ...request(), useBoundary: base.useBoundary }, valid);
        const previous = informational.currentDecision;
        const currentOwnerRevision = 'R2';
        const result = yield* run(request(previous), (input) => {
          expect(currentOwnerRevision).toBe('R2');
          return Effect.succeed(proof(input.evidence, input.useBoundary, 'R1'));
        });
        expect(result.currentDecision.decision.outcome).toBe('AVAILABLE');
        expect(result.currentDecision.decision.useBoundary.kind).toBe('ORDER_COMMITMENT');
        expect(result.bundleDisposition).toBe('UNCHANGED');
        expect(result.originalDecision?.decision.useBoundary.kind).toBe('INFORMATIONAL');
      }),
  );

  it.effect('rejects duplicate owners and fresh proof lineage bound to a different exact snapshot', () =>
    Effect.gen(function* exactProofBinding() {
      const duplicate = yield* run(request(), (input) => {
        const completeProof = proof(input.evidence, input.useBoundary);
        const [first] = completeProof.materialEvidence;
        return Effect.succeed({
          ...completeProof,
          materialEvidence:
            first === undefined
              ? []
              : completeProof.materialEvidence.map((entry) => (entry.owner === 'ASSORTMENT' ? first : entry)),
        });
      });
      expect(duplicate.currentDecision.currentness).toBe('INDETERMINATE');
      const freshButDifferent = yield* run(request(), (input) => {
        const completeProof = proof(input.evidence, input.useBoundary);
        const verification = completeProof.subject.purchasingContext.contextVerification;
        return Effect.succeed({
          ...completeProof,
          subject: {
            ...completeProof.subject,
            purchasingContext: {
              contextVerification: {
                ...verification,
                evidence: { ...verification.evidence, verificationRef: 'other-proof' },
              },
            },
          },
        });
      });
      expect(freshButDifferent.currentDecision.currentness).toBe('INDETERMINATE');
      expect(freshButDifferent.currentDecision.currentnessReasons).toContain('OWNER_PROOF_SCOPE_OR_VALIDITY_MISMATCH');
    }),
  );

  it.effect('requires all five material owner contracts, not only Inventory rows', () =>
    Effect.gen(function* incompleteContracts() {
      const result = yield* run(request(), (input) => {
        const completeProof = proof(input.evidence, input.useBoundary);
        return Effect.succeed({
          ...completeProof,
          materialEvidence: completeProof.materialEvidence.filter((entry) => entry.owner !== 'ASSORTMENT'),
        });
      });
      expect(result.currentDecision.decision.outcome).toBe('INDETERMINATE');
    }),
  );

  it.effect(
    'can safely finish after whole-snapshot retry with owner-proven coherence across different revision tokens',
    () =>
      Effect.gen(function* coherentRetry() {
        let calls = 0;
        const result = yield* run(request(), (input) => {
          calls += 1;
          if (calls === 1) {
            return Effect.succeed({ _tag: 'UNPROVEN' as const, reason: 'MIXED_R1_R2' });
          }
          const coherent = proof(input.evidence, input.useBoundary);
          return Effect.succeed({
            ...coherent,
            materialEvidence: coherent.materialEvidence.map((entry, index) => ({
              ...entry,
              sourceRevisionRefs: [index === 0 ? 'R1' : 'R2'],
            })),
          });
        });
        expect(calls).toBe(2);
        expect(result.currentDecision.decision.outcome).toBe('AVAILABLE');
      }),
  );
  it.effect(
    'preserves external assertion, committed obligation, source coverage and unresolved effects while using independently proven support',
    () =>
      Effect.gen(function* richEvidence() {
        const external = makeRichExternalCurrentnessInput();
        const result = yield* run({ ...request(), subject: external.subject }, valid, external);
        expect(result.currentDecision.decision.outcome).toBe('AVAILABLE');
        expect(result.currentDecision.decision.evidence.stockInput).toEqual(external.stockInput);
        expect(result.currentDecision.decision.reasons).toContain('SOURCE_COVERAGE_UNCERTAIN');
        expect(result.currentDecision.decision.reasons).toContain('UNRESOLVED_RESERVATION_EFFECT');
        const five = { ...external.subject, quantity: { ...external.subject.quantity, amount: '5' } };
        const insufficient = {
          ...external,
          ownerQualification: { ...external.ownerQualification, subject: five },
          subject: five,
        };
        const uncertain = yield* run({ ...request(), subject: five }, valid, insufficient);
        expect(uncertain.currentDecision.decision.outcome).toBe('INDETERMINATE');
        expect(uncertain.currentDecision.decision.reasons).toContain('INDEPENDENT_SUPPORT_INSUFFICIENT');
      }),
  );
});
