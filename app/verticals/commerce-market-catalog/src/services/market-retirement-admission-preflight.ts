import type { ActionServiceFactory, ActionServicePreflight, ActionServicePreparationContext } from '@app/core-runtime';
import { OperationContextUnavailable, TrustedPrincipalContextSchema, requireModuleOperation } from '@app/core-runtime';
import type { Crypto } from 'effect';
import { Effect, Option, Result, Schema } from 'effect';
import { RetireMarketPayloadSchema } from '../../shared/action-contracts.ts';
import type { ManageMarketRetirementAdmissionPayload } from '../../shared/market-retirement-admission.ts';
import type { MarketRetirementImpactAssessmentRejected } from '../actions/market-retirement-impact-assessment-rejected.ts';
import type { MarketRetirementImpactAssessmentStale } from '../actions/market-retirement-impact-assessment-stale.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';
import { marketRetirementAdmissionPersistence } from '../persistence/market-retirement-admission-persistence.ts';
import { MarketRetirementImpactAuthorityFactory } from './market-retirement-impact-authority.ts';
import { makeMarketRetirementAdmissionService } from './market-retirement-admission.service.ts';
import type {
  MarketRetirementAdmissionService,
  MarketRetirementPreparedBasis,
} from './market-retirement-admission.service.ts';

type MarketRetirementAdmissionDomainError =
  | MarketRetirementImpactAssessmentRejected
  | MarketRetirementImpactAssessmentStale
  | MarketRetirementImpactAssessmentUnavailable;

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);

const unavailable = (reason: string, cause?: unknown) => {
  const failure = new MarketRetirementImpactAssessmentUnavailable({
    code: 'market_retirement_impact_assessment_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/**
 * The original requester's retirement basis, resolved outside the owner's write transaction. `none`
 * means the owner snapshot already answered the command, so no remote work was needed at all. Any
 * doubt about that snapshot prepares the basis rather than skipping it, and the write transaction
 * still re-reads the owner row before it writes anything.
 */
const prepareRetirementBasis = Effect.fn('MarketRetirementAdmission.prepareBasis')(function* prepareRetirementBasis(
  payload: ManageMarketRetirementAdmissionPayload,
  context: ActionServicePreparationContext,
): Effect.fn.Return<MarketRetirementPreparedBasis, never, Crypto.Crypto | MarketRetirementImpactAuthorityFactory> {
  if (payload.operation === 'ABORT') {
    return Option.none();
  }
  const observed = yield* Effect.result(
    context.transaction(
      Effect.fn('MarketRetirementAdmission.observeAdmission')(function* observeAdmission(transaction) {
        const persistence = yield* marketRetirementAdmissionPersistence(
          transaction,
          context.scope,
          context.compositionRevision,
        );
        return yield* Effect.result(
          persistence.recover({
            marketRef: payload.retirement.marketRef,
            sourceActionInvocationId: payload.sourceActionInvocationId,
          }),
        );
      }),
    ),
  );
  if (
    Result.isSuccess(observed) &&
    Result.isSuccess(observed.success) &&
    observed.success.success.outcome !== 'NOT_FOUND'
  ) {
    return Option.none();
  }
  return Option.some(
    yield* Effect.result(
      Effect.gen(function* prepareOriginalBasis() {
        const retirement = yield* Schema.decodeUnknownEffect(RetireMarketPayloadSchema)(payload.retirement).pipe(
          Effect.mapError((cause) => unavailable('Original retirement intent is invalid', cause)),
        );
        yield* requireModuleOperation('commerce.market-catalog.requirement.retirement-affected-use').pipe(
          Effect.mapError((cause) => unavailable('Current retirement affected-use contract is unavailable', cause)),
        );
        const authority = yield* MarketRetirementImpactAuthorityFactory;
        return yield* authority.prepareBasis({
          compositionRevision: context.compositionRevision,
          retirement,
          scope: context.scope,
          sourceActionInvocationId: payload.sourceActionInvocationId,
        });
      }),
    ),
  );
});

/**
 * The Action's staged preparation (D14): the delegated gateway issuance and the Customer Context
 * assessment happen here, before the guarded write transaction, and the factory hands the owner write
 * the exact basis plus the invocation-local scope it was prepared under.
 */
export const prepareMarketRetirementAdmissionServices = Effect.fn('MarketRetirementAdmission.prepareServices')(
  function* prepareMarketRetirementAdmissionServices(
    payload: ManageMarketRetirementAdmissionPayload,
    context: ActionServicePreparationContext,
  ) {
    const preparedBasis = yield* prepareRetirementBasis(payload, context);
    const factory: ActionServiceFactory<MarketRetirementAdmissionService, Crypto.Crypto> = Effect.fn(
      'MarketRetirementAdmission.commitServices',
    )(function* commitRetirementAdmissionServices(transaction, scope, compositionRevision) {
      if (
        scope.tenantId !== context.scope.tenantId ||
        scope.legalEntityId !== context.scope.legalEntityId ||
        !samePrincipal(scope, context.scope) ||
        scope.correlationId !== context.scope.correlationId ||
        compositionRevision !== context.compositionRevision
      ) {
        return yield* new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Prepared retirement basis belongs to another operation context',
        });
      }
      return yield* makeMarketRetirementAdmissionService(preparedBasis)(transaction, scope, compositionRevision);
    });
    return factory;
  },
) satisfies ActionServicePreflight<
  ManageMarketRetirementAdmissionPayload,
  MarketRetirementAdmissionService,
  MarketRetirementAdmissionDomainError,
  Crypto.Crypto | MarketRetirementImpactAuthorityFactory
>;
