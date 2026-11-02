import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor, ActionServicePreparationContext } from '@app/core-runtime';
import {
  PricingCommitmentConfirmationIssuedSchema,
  PricingCommitmentConfirmationBindingSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingQuotationBindingSchema, PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import type { ManageCommitmentConfirmationActionServices } from '../actions/manage-commitment-confirmation.action.ts';
import type { CommitmentConfirmationPersistence } from '../services/commitment-confirmation-persistence.service.ts';
import { commitmentConfirmationPersistenceForScope } from '../services/commitment-confirmation-persistence.service.ts';
import {
  PricingCommitmentConfirmationRenewalFactory,
  pricingCommitmentConfirmationRenewalFactoryLive,
} from '../services/commitment-confirmation-renewal.service.ts';
import {
  PricingCommitmentConfirmationVerificationFactory,
  pricingCommitmentConfirmationVerificationFactoryLive,
  PricingCommitmentConfirmationOwnerVerifierUnavailable,
} from '../services/commitment-confirmation-verification.service.ts';
import type {
  PricingQuotationBackedConfirmationIssuanceCandidate,
  PricingQuotationBackedConfirmationIssuanceService,
} from '../services/quotation-backed-confirmation-issuance.service.ts';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import {
  PricingQuotationBackedConfirmationIssuanceFactory,
  pricingQuotationBackedConfirmationIssuanceFactoryLive,
  PricingCommitmentConfirmationProofIssuanceUnavailable,
} from '../services/quotation-backed-confirmation-issuance.service.ts';
import { PricingQuotationBackedConfirmationBindingUnavailable } from '../services/quotation-backed-confirmation-binding-unavailable.ts';
import { quotationPersistenceForScope } from '../services/quotation-persistence.service.ts';
import {
  PricingQuotationRevalidationFactory,
  pricingQuotationRevalidationFactoryLive,
} from '../services/quotation-revalidation.service.ts';
import { pricingCommitmentOwnerProof } from './commitment-confirmation-owner-proof.ts';
import { assertPreparedPricingScope } from './commercial-fee-catalog-target-evidence.ts';
import type { ManageCommitmentConfirmationPayload } from '../../shared/actions/manage-commitment-confirmation.ts';
import {
  PricingFinalizationAuthorityUnavailable,
  pricingFinalizationOwnerGateways,
} from './order-finalization-owner-gateways.ts';

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

const verifyRetainedOwnerProof = Effect.fn('PricingCommitmentConfirmation.verifyOwnerProof')(function* verifyOwnerProof(
  proof: Effect.Success<typeof pricingCommitmentOwnerProof>,
  confirmation: typeof PricingCommitmentConfirmationIssuedSchema.Type,
  verifiedAt: string,
) {
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
});

/** Immutable SQL instance in, owner-private cryptographic verification out. No remote owner or SQL service. */
export const commitmentConfirmationVerificationForRetained = Effect.fn(
  'PricingCommitmentConfirmation.verificationForRetained',
)(function* verificationForRetained(retained: typeof PricingCommitmentConfirmationIssuedSchema.Type) {
  const proof = yield* pricingCommitmentOwnerProof.pipe(Effect.mapError(unavailable));
  const factory = yield* PricingCommitmentConfirmationVerificationFactory;
  return {
    verify: Effect.fn('PricingCommitmentConfirmation.verifyScoped')(function* verifyScoped(
      request: Parameters<typeof factory.prepare>[0],
    ) {
      const validated = factory.prepare(request);
      if ('outcome' in validated) {
        return validated.outcome;
      }
      const { attemptedAt: verifiedAt, confirmation } = validated.request;
      const ownerResult = yield* Effect.gen(function* verifyRetainedProof() {
        if (!sameConfirmation(retained, confirmation)) {
          return {
            _tag: 'AUTHENTICITY_INVALID' as const,
            confirmationRef: confirmation.confirmationRef,
            reason: 'PAYLOAD_TAMPERED' as const,
            retryable: false as const,
          };
        }
        return yield* verifyRetainedOwnerProof(proof, confirmation, verifiedAt);
      }).pipe(Effect.catchTag('PricingCommitmentConfirmationOwnerVerifierUnavailable', () => Effect.succeed(null)));
      return factory.finish(
        validated.request,
        Option.getOrNull(
          Schema.decodeUnknownOption(factory.ownerOutcomeSchema, { onExcessProperty: 'error' })(ownerResult),
        ),
      );
    }),
  };
});

/** Real owner-backed ports for the selected Quotation finalization path. No Current result is synthesized. */
export type CommitmentConfirmationProductionServices = ManageCommitmentConfirmationActionServices & {
  readonly recoverIssuance: CommitmentConfirmationPersistence['recoverIssuance'];
};

export const commitmentConfirmationProductionForScope = Effect.fn('PricingCommitmentConfirmation.productionForScope')(
  function* productionForScope(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    compositionRevision: string | undefined,
    preparedBinding?: Effect.Success<ReturnType<typeof pricingFinalizationOwnerGateways>>['verifyBinding'],
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
    const verifyBinding = preparedBinding ?? owners.verifyBinding;
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
    const verificationFactory = yield* PricingCommitmentConfirmationVerificationFactory;
    const verification = {
      verify: Effect.fn('PricingCommitmentConfirmation.verifyScoped')(function* verifyScoped(
        request: Parameters<typeof verificationFactory.prepare>[0],
      ) {
        const validated = verificationFactory.prepare(request);
        if ('outcome' in validated) {
          return validated.outcome;
        }
        const { attemptedAt: verifiedAt, confirmation } = validated.request;
        const ownerResult = yield* Effect.gen(function* verifyRetainedProof() {
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
          return yield* verifyRetainedOwnerProof(proof, confirmation, verifiedAt);
        }).pipe(Effect.catchTag('PricingCommitmentConfirmationOwnerVerifierUnavailable', () => Effect.succeed(null)));
        return verificationFactory.finish(
          validated.request,
          Option.getOrNull(
            Schema.decodeUnknownOption(verificationFactory.ownerOutcomeSchema, { onExcessProperty: 'error' })(
              ownerResult,
            ),
          ),
        );
      }),
    };
    const [revalidationFactory, issuanceFactory, renewalFactory] = yield* Effect.all(
      [
        PricingQuotationRevalidationFactory,
        PricingQuotationBackedConfirmationIssuanceFactory,
        PricingCommitmentConfirmationRenewalFactory,
      ],
      { concurrency: 1 },
    );
    const quotationIssuance: PricingQuotationBackedConfirmationIssuanceService = {
      issue: Effect.fn('PricingCommitmentConfirmation.issueQuotation')(function* issueQuotation(
        input: PricingQuotationBackedConfirmationIssuanceCandidate,
      ) {
        const authorized = yield* verifyBinding(input.binding).pipe(Effect.option);
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
        const revalidation = revalidationFactory.make({
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
        return yield* issuanceFactory
          .make({
            bindingAuthority: {
              verifyUnchangedBinding: ({ binding }) =>
                verifyBinding(binding).pipe(Effect.asVoid, Effect.mapError(bindingUnavailable)),
            },
            proofIssuer: {
              issueProof: (unsigned) => proof.issueProof(unsigned).pipe(Effect.mapError(proofUnavailable)),
            },
            revalidation,
          })
          .issue(input);
      }),
    };
    const renewal = renewalFactory.make({ currentIssuance: current, quotationIssuance });
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
  },
);

/** Released owner binding reads, then immutable SQL-source revalidation inside the Action commit. */
export const prepareCommitmentConfirmationProductionServices = Effect.fn(
  'PricingCommitmentConfirmation.prepareServices',
)(function* prepareServices(payload: ManageCommitmentConfirmationPayload, context: ActionServicePreparationContext) {
  const binding = payload.kind === 'VERIFY_COMMITMENT_CONFIRMATION' ? payload.requestedBinding : payload.binding;
  if (
    binding.purchase.tenantId !== context.scope.tenantId ||
    binding.purchase.commercialScope.sellingLegalEntityId !== context.scope.legalEntityId
  ) {
    return yield* unavailable('Commitment preparation does not match the trusted Tenant and Selling Legal Entity');
  }
  const load = Effect.fn('PricingCommitmentConfirmation.loadPreparedSource')(function* loadSource(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
  ) {
    const confirmations = yield* commitmentConfirmationPersistenceForScope(transaction, scope);
    const quotations = yield* quotationPersistenceForScope(transaction, scope);
    const quotation =
      payload.kind === 'ISSUE_QUOTATION_BACKED_CONFIRMATION'
        ? yield* quotations.read(payload.quotationRef)
        : Option.none();
    const previous =
      payload.kind === 'RENEW_COMMITMENT_CONFIRMATION' || payload.kind === 'VERIFY_COMMITMENT_CONFIRMATION'
        ? yield* confirmations.recover(payload.confirmationRef)
        : undefined;
    return { previous, quotation };
  });
  const { before, owners } = yield* Effect.all(
    {
      before: context.transaction((transaction) => load(transaction, context.scope)).pipe(Effect.mapError(unavailable)),
      owners: pricingFinalizationOwnerGateways(context.scope, context.compositionRevision).pipe(
        Effect.mapError(unavailable),
      ),
    },
    { concurrency: 2 },
  );
  const needsBinding =
    Option.isSome(before.quotation) ||
    (payload.kind === 'RENEW_COMMITMENT_CONFIRMATION' &&
      before.previous?.outcome === 'FOUND' &&
      before.previous.confirmation.source.kind === 'QUOTATION_BACKED');
  const observedBinding = needsBinding ? yield* Effect.result(owners.verifyBinding(binding)) : undefined;
  const preparedBinding: typeof owners.verifyBinding = (requested) =>
    Schema.toEquivalence(PricingCommitmentConfirmationBindingSchema)(binding, requested) &&
    observedBinding !== undefined
      ? Effect.fromResult(observedBinding)
      : Effect.fail(
          new PricingFinalizationAuthorityUnavailable({
            reason: 'No owner observation exists for this exact prepared Commitment binding',
          }),
        );
  const recoverySchema = Schema.Union([
    Schema.Struct({ confirmation: PricingCommitmentConfirmationIssuedSchema, outcome: Schema.Literal('FOUND') }),
    Schema.Struct({ confirmationRef: Schema.String, outcome: Schema.Literal('ABSENT') }),
    Schema.Struct({ confirmationRef: Schema.String, outcome: Schema.Literal('CORRUPT'), reason: Schema.String }),
  ]);
  const factory = Effect.fn('PricingCommitmentConfirmation.commitPreparedServices')(function* commitServices(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    revision: string,
  ) {
    yield* assertPreparedPricingScope(context, scope, revision);
    const current = yield* load(transaction, scope).pipe(Effect.mapError(unavailable));
    if (
      (Option.isSome(before.quotation)
        ? Option.isNone(current.quotation) || !sameQuotation(before.quotation.value, current.quotation.value)
        : Option.isSome(current.quotation)) ||
      (before.previous === undefined
        ? current.previous !== undefined
        : current.previous === undefined || !Schema.toEquivalence(recoverySchema)(before.previous, current.previous))
    ) {
      return yield* unavailable(
        'The exact retained Quotation or Confirmation changed during owner binding verification',
      );
    }
    return yield* commitmentConfirmationProductionForScope(transaction, scope, revision, preparedBinding);
  });
  return factory;
});

export class PricingCommitmentConfirmationProduction extends Context.Service<
  PricingCommitmentConfirmationProduction,
  {
    readonly forScope: typeof commitmentConfirmationProductionForScope;
    readonly prepareServices?: typeof prepareCommitmentConfirmationProductionServices;
  }
>()('@app/pricing/integrations/commitment-confirmation-production/PricingCommitmentConfirmationProduction') {}
export const pricingCommitmentConfirmationProductionLive = Layer.succeed(PricingCommitmentConfirmationProduction, {
  forScope: commitmentConfirmationProductionForScope,
  prepareServices: prepareCommitmentConfirmationProductionServices,
});

export const pricingCommitmentAlgorithmFactoriesLive = Layer.mergeAll(
  pricingCommitmentConfirmationRenewalFactoryLive,
  pricingCommitmentConfirmationVerificationFactoryLive,
  pricingQuotationBackedConfirmationIssuanceFactoryLive,
  pricingQuotationRevalidationFactoryLive,
);
