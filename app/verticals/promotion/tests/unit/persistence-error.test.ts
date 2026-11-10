import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { mapProvisionVoucherActionProblem } from '../../api/provision-voucher-action-problems.ts';
import { mapSetBasisPolicyActionProblem } from '../../api/set-basis-policy-action-problems.ts';
import { issuePromotionProofAction } from '../../src/actions/issue-promotion-proof.action.ts';
import { setBasisPolicyAction } from '../../src/actions/set-basis-policy.action.ts';
import { previewPromotionsRead } from '../../src/api/preview-promotions.read.ts';
import { PromotionEvaluationFailure } from '../../src/services/evaluation.service.ts';
import {
  PromotionMonetaryInvalid,
  PromotionMonetaryPrecisionUnsupported,
  PromotionMonetaryUnavailable,
  PromotionMonetaryUnverifiable,
} from '../../src/services/monetary.service.ts';
import { PromotionPersistenceUnavailable, PromotionStateConflict } from '../../src/services/persistence.service.ts';
import { PromotionProofFailure } from '../../src/services/proof.service.ts';
import { PromotionSelectionFailure } from '../../src/services/selection.service.ts';

const reason = 'Controlled internal storage diagnostic';

it('maps permanent Voucher code attribution to a sanitized conflict409', () => {
  const failure = new PromotionStateConflict({ code: 'CODE_ALREADY_BOUND', reason });
  const problem = mapProvisionVoucherActionProblem(failure);
  expect(problem.status).toBe(409);
  expect(problem).toHaveProperty('code', 'CODE_ALREADY_BOUND');
  expect(problem.detail).not.toContain(reason);
  expect(problem).not.toHaveProperty('cause');
});

it.effect('retains a native persistence cause in the declared Action channel and maps only sanitized503', () =>
  Effect.gen(function* nativePersistenceErrorContract() {
    const cause = new Error('Controlled native cause');
    const failure = new PromotionPersistenceUnavailable({ cause, code: 'promotion_persistence_unavailable', reason });
    const decoded = yield* Schema.decodeUnknownEffect(setBasisPolicyAction.descriptor.domainErrorSchema)(failure);
    expect(Schema.is(PromotionPersistenceUnavailable)(decoded)).toBe(true);
    if (Schema.is(PromotionPersistenceUnavailable)(decoded)) {
      expect(decoded.cause).toBe(cause);
    }
    const publicProblem = mapSetBasisPolicyActionProblem(decoded);
    expect(publicProblem.status).toBe(503);
    expect(publicProblem).not.toHaveProperty('cause');
    expect(publicProblem.detail).not.toContain(reason);
    expect(publicProblem.detail).not.toContain(cause.message);
  }),
);

it.effect('retains native proof and evaluator causes through their actual Action and governed Read error schemas', () =>
  Effect.gen(function* nativeOwnerErrorContracts() {
    const readDomainSchema = yield* Effect.fromOption(
      Option.fromUndefinedOr(previewPromotionsRead.descriptor.domainErrorSchema),
    );
    const cause = new Error('Controlled native owner diagnostic');
    const proof = new PromotionProofFailure({ cause, code: 'UNAVAILABLE', reason });
    const proofDecoded = yield* Schema.decodeUnknownEffect(issuePromotionProofAction.descriptor.domainErrorSchema)(
      proof,
    );
    expect(Schema.is(PromotionProofFailure)(proofDecoded)).toBe(true);
    if (Schema.is(PromotionProofFailure)(proofDecoded)) {
      expect(proofDecoded.cause).toBe(cause);
    }
    const evaluation = new PromotionEvaluationFailure({ cause, code: 'UNAVAILABLE', reason });
    const evaluationDecoded = yield* Schema.decodeUnknownEffect(readDomainSchema)(evaluation);
    expect(Schema.is(PromotionEvaluationFailure)(evaluationDecoded)).toBe(true);
    if (Schema.is(PromotionEvaluationFailure)(evaluationDecoded)) {
      expect(evaluationDecoded.cause).toBe(cause);
    }
    const selection = new PromotionSelectionFailure({ cause, code: 'UNAVAILABLE', reason });
    const selectionDecoded = yield* Schema.decodeUnknownEffect(readDomainSchema)(selection);
    expect(Schema.is(PromotionSelectionFailure)(selectionDecoded)).toBe(true);
    if (Schema.is(PromotionSelectionFailure)(selectionDecoded)) {
      expect(selectionDecoded.cause).toBe(cause);
    }
  }),
);

it.effect('retains every monetary error family with a native cause through the actual Read contract', () =>
  Effect.gen(function* nativeMonetaryErrorContracts() {
    const readDomainSchema = yield* Effect.fromOption(
      Option.fromUndefinedOr(previewPromotionsRead.descriptor.domainErrorSchema),
    );
    const cause = new Error('Controlled native monetary diagnostic');
    const failures = [
      new PromotionMonetaryInvalid({ cause, code: 'promotion_monetary_invalid', reason }),
      new PromotionMonetaryPrecisionUnsupported({ cause, code: 'promotion_monetary_precision_unsupported', reason }),
      new PromotionMonetaryUnavailable({ cause, code: 'promotion_monetary_unavailable', reason }),
      new PromotionMonetaryUnverifiable({ cause, code: 'promotion_monetary_unverifiable', reason }),
    ];
    const monetarySchema = Schema.Union([
      PromotionMonetaryInvalid,
      PromotionMonetaryPrecisionUnsupported,
      PromotionMonetaryUnavailable,
      PromotionMonetaryUnverifiable,
    ]);
    for (const failure of failures) {
      const decoded = yield* Schema.decodeUnknownEffect(readDomainSchema)(failure);
      expect(Schema.is(monetarySchema)(decoded)).toBe(true);
      if (Schema.is(monetarySchema)(decoded)) {
        expect(decoded.cause).toBe(cause);
        expect(decoded.code).toBe(failure.code);
      }
    }
  }),
);
