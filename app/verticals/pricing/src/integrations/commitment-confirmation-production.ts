import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedTransactionExecutor } from '@app/core-runtime';
import { PricingCommitmentConfirmationIssuedSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingQuotationBindingSchema, PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import type { ManageCommitmentConfirmationActionServices } from '../actions/manage-commitment-confirmation.action.ts';
import type { CommitmentConfirmationPersistence } from '../services/commitment-confirmation-persistence.service.ts';
import { commitmentConfirmationPersistenceForScope } from '../services/commitment-confirmation-persistence.service.ts';
import { makePricingCommitmentConfirmationRenewalService } from '../services/commitment-confirmation-renewal.service.ts';
import {
  makePricingCommitmentConfirmationVerificationService,
  PricingCommitmentConfirmationOwnerVerifier,
  PricingCommitmentConfirmationOwnerVerifierUnavailable,
} from '../services/commitment-confirmation-verification.service.ts';
import type {
  PricingQuotationBackedConfirmationIssuanceCandidate,
  PricingQuotationBackedConfirmationIssuanceService,
} from '../services/quotation-backed-confirmation-issuance.service.ts';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import type { PricingCommitmentConfirmationOwnerVerificationInput } from '../services/commitment-confirmation-verification.service.ts';
import {
  makePricingQuotationBackedConfirmationIssuanceService,
  PricingCommitmentConfirmationProofIssuanceUnavailable,
} from '../services/quotation-backed-confirmation-issuance.service.ts';
import { PricingQuotationBackedConfirmationBindingUnavailable } from '../services/quotation-backed-confirmation-binding-unavailable.ts';
import { quotationPersistenceForScope } from '../services/quotation-persistence.service.ts';
import { makePricingQuotationRevalidationService } from '../services/quotation-revalidation.service.ts';
import { pricingCommitmentOwnerProof } from './commitment-confirmation-owner-proof.ts';
import { pricingFinalizationOwnerGateways } from './order-finalization-owner-gateways.ts';

const sameQuotation = Schema.toEquivalence(PricingQuotationIssuedSchema);
const sameConfirmation = Schema.toEquivalence(PricingCommitmentConfirmationIssuedSchema);
const samePurchase = Schema.toEquivalence(PricingQuotationBindingSchema);
const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Production Pricing Commitment authority is unavailable',
    }),
    'cause',
    { value: cause },
  );
const proofUnavailable = (cause: unknown) =>
  new PricingCommitmentConfirmationProofIssuanceUnavailable({
    cause,
    reason: 'ISSUER_UNAVAILABLE',
    retryable: true,
  });
const bindingUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new PricingQuotationBackedConfirmationBindingUnavailable({
      reason: 'The permanent Order binding and final Cart authority could not be verified',
      retryable: true,
    }),
    'cause',
    { value: cause },
  );

/** Real owner-backed ports for the selected Quotation finalization path. No Current result is synthesized. */
export type CommitmentConfirmationProductionServices = ManageCommitmentConfirmationActionServices & {
  readonly recoverIssuance: CommitmentConfirmationPersistence['recoverIssuance'];
};

export const commitmentConfirmationProductionForScope: ReadServiceFactory<CommitmentConfirmationProductionServices> =
  Effect.fn('PricingCommitmentConfirmation.productionForScope')(function* productionForScope(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    compositionRevision: string | undefined,
  ) {
    // Core read factories can receive no revision; an absent revision must never reach an owner gateway.
    if (compositionRevision === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Pricing Commitment composition revision is unavailable',
      });
    }
    const proof = yield* pricingCommitmentOwnerProof.pipe(Effect.mapError(unavailable));
    const owners = yield* pricingFinalizationOwnerGateways(scope, compositionRevision).pipe(
      Effect.mapError(unavailable),
    );
    const persistence = yield* commitmentConfirmationPersistenceForScope(transaction, scope);
    const quotations = yield* quotationPersistenceForScope(transaction, scope);
    const current = {
      issue: () =>
        Effect.succeed({
          _tag: 'SOURCE_UNVERIFIABLE' as const,
          reason: 'CURRENT_CONFIRMATION_PRODUCTION_AUTHORITY_NOT_INSTALLED',
          retryable: true as const,
        }),
    };
    const verification = yield* makePricingCommitmentConfirmationVerificationService.pipe(
      Effect.provideService(PricingCommitmentConfirmationOwnerVerifier, {
        verifyImmutableConfirmation: Effect.fn('PricingCommitmentConfirmation.verifyRetainedProof')(
          function* verifyRetainedProof({
            confirmation,
            verifiedAt,
          }: PricingCommitmentConfirmationOwnerVerificationInput) {
            const stored = yield* persistence.recover(confirmation.confirmationRef).pipe(
              Effect.mapError(
                (cause) =>
                  new PricingCommitmentConfirmationOwnerVerifierUnavailable({
                    cause,
                    reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE',
                  }),
              ),
            );
            if (stored.outcome !== 'FOUND' || !sameConfirmation(stored.confirmation, confirmation)) {
              return {
                _tag: 'AUTHENTICITY_INVALID' as const,
                confirmationRef: confirmation.confirmationRef,
                reason: 'PAYLOAD_TAMPERED' as const,
                retryable: false as const,
              };
            }
            if (!proof.ownsKey(confirmation.authenticity)) {
              return {
                _tag: 'AUTHENTICITY_UNVERIFIABLE' as const,
                confirmationRef: confirmation.confirmationRef,
                reason: 'UNKNOWN_KEY' as const,
                retryable: false as const,
              };
            }
            const valid = yield* proof.verifyProof(confirmation).pipe(
              Effect.mapError(
                (cause) =>
                  new PricingCommitmentConfirmationOwnerVerifierUnavailable({
                    cause,
                    reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE',
                  }),
              ),
            );
            return valid
              ? {
                  _tag: 'VERIFIED' as const,
                  authenticityEvidence: {
                    authenticityRef: confirmation.authenticity.proofRef,
                    confirmationRef: confirmation.confirmationRef,
                    issuerRef: confirmation.authenticity.issuerRef,
                    keyRef: confirmation.authenticity.keyRef,
                    keyStatus: 'ACTIVE' as const,
                    keyVersion: confirmation.authenticity.keyVersion,
                    lineageRef: confirmation.authenticity.lineageRef,
                    payloadDigest: confirmation.authenticity.payloadDigest,
                    proofRef: confirmation.authenticity.proofRef,
                    proofVersion: confirmation.authenticity.proofVersion,
                    verifiedAt,
                  },
                }
              : {
                  _tag: 'AUTHENTICITY_INVALID' as const,
                  confirmationRef: confirmation.confirmationRef,
                  reason: 'INVALID_PROOF' as const,
                  retryable: false as const,
                };
          },
        ),
      }),
    );
    const quotationIssuance: PricingQuotationBackedConfirmationIssuanceService = {
      issue: Effect.fn('PricingCommitmentConfirmation.issueQuotation')(function* issueQuotation(
        input: PricingQuotationBackedConfirmationIssuanceCandidate,
      ) {
        const authorized = yield* owners.verifyBinding(input.binding).pipe(Effect.option);
        if (Option.isNone(authorized)) {
          return {
            _tag: 'SOURCE_UNVERIFIABLE' as const,
            reason: 'PERMANENT_ORDER_BINDING_UNVERIFIABLE',
            retryable: true as const,
          };
        }
        if (
          !sameDecision(input.quotation.quotedResult.decision, {
            ...authorized.value.pricing.decision,
            operationTime: input.quotation.quotedResult.decision.operationTime,
          }) ||
          input.quotation.issuedAt < input.quotation.quotedResult.decision.operationTime
        ) {
          return { _tag: 'BINDING_MISMATCH' as const, reason: 'PURCHASE_CHANGED' as const, retryable: false as const };
        }
        const revalidation = makePricingQuotationRevalidationService({
          authenticity: {
            verify: Effect.fn('PricingQuotation.verifyRetainedOwnerInstance')(function* verify({
              quotation,
            }: {
              readonly quotation: PricingQuotationIssued;
            }) {
              const stored = yield* quotations.read(quotation.quotationRef).pipe(
                Effect.match({
                  onFailure: (cause) => ({ cause, kind: 'UNAVAILABLE' as const }),
                  onSuccess: (value) => ({ kind: 'READ' as const, value }),
                }),
              );
              if (stored.kind === 'UNAVAILABLE') {
                return {
                  kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE' as const,
                  quotationRef: quotation.quotationRef,
                  reason: 'DEPENDENCY_UNAVAILABLE' as const,
                  retryable: true as const,
                };
              }
              if (Option.isNone(stored.value) || !sameQuotation(stored.value.value, quotation)) {
                return {
                  kind: 'QUOTATION_AUTHENTICITY_INVALID' as const,
                  quotationRef: quotation.quotationRef,
                  reason: 'PAYLOAD_TAMPERED' as const,
                };
              }
              const evidence = yield* proof
                .quotationEvidence(quotation, DateTime.formatIso(yield* DateTime.now))
                .pipe(Effect.option);
              return Option.isSome(evidence)
                ? { evidence: evidence.value, kind: 'QUOTATION_AUTHENTIC' as const }
                : {
                    kind: 'QUOTATION_AUTHENTICITY_UNVERIFIABLE' as const,
                    quotationRef: quotation.quotationRef,
                    reason: 'DEPENDENCY_UNAVAILABLE' as const,
                    retryable: true as const,
                  };
            }),
          },
          binding: {
            assess: (request) =>
              Effect.succeed(
                samePurchase(input.binding.purchase, request.requestedBinding) &&
                  samePurchase(request.quotation.binding, request.requestedBinding) &&
                  request.proposedEvidence === undefined
                  ? { kind: 'EXACT_MATCH' as const, quotationRef: request.quotation.quotationRef }
                  : {
                      kind: 'MISMATCH' as const,
                      quotationRef: request.quotation.quotationRef,
                      reason: 'AUTHORITY_CONTEXT_CHANGED' as const,
                    },
              ),
          },
          validity: {
            verify: Effect.fn('PricingQuotation.ownerTrustedValidity')(function* verify(request) {
              const evaluatedAt = DateTime.formatIso(yield* DateTime.now);
              const fields = {
                evaluatedAt,
                quotationRef: request.quotation.quotationRef,
                validity: request.quotation.validity,
              };
              if (evaluatedAt < fields.validity.validFrom) {
                return { ...fields, _tag: 'INVALID' as const, reason: 'NOT_YET_VALID' as const };
              }
              if (evaluatedAt >= fields.validity.validUntil) {
                return { ...fields, _tag: 'EXPIRED' as const };
              }
              return { ...fields, _tag: 'VALID' as const };
            }),
          },
        });
        return yield* makePricingQuotationBackedConfirmationIssuanceService({
          bindingAuthority: {
            verifyUnchangedBinding: ({ binding }) =>
              owners.verifyBinding(binding).pipe(Effect.asVoid, Effect.mapError(bindingUnavailable)),
          },
          proofIssuer: { issueProof: (unsigned) => proof.issueProof(unsigned).pipe(Effect.mapError(proofUnavailable)) },
          revalidation,
        }).issue(input);
      }),
    };
    const renewal = makePricingCommitmentConfirmationRenewalService({ currentIssuance: current, quotationIssuance });
    return {
      issueCurrent: current.issue,
      issueQuotation: quotationIssuance.issue,
      readQuotation: quotations.read,
      recoverConfirmation: persistence.recover,
      recoverIssuance: persistence.recoverIssuance,
      renew: renewal.renew,
      store: persistence.store,
      verify: verification.verify,
    } satisfies ManageCommitmentConfirmationActionServices & {
      readonly recoverIssuance: typeof persistence.recoverIssuance;
    };
  });

export class PricingCommitmentConfirmationProduction extends Context.Service<
  PricingCommitmentConfirmationProduction,
  { readonly forScope: typeof commitmentConfirmationProductionForScope }
>()('@app/pricing/integrations/commitment-confirmation-production/PricingCommitmentConfirmationProduction') {}
export const pricingCommitmentConfirmationProductionLive = Layer.succeed(PricingCommitmentConfirmationProduction, {
  forScope: commitmentConfirmationProductionForScope,
});
