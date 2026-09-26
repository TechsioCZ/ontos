import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Context, Effect, Option } from 'effect';

import type {
  ChangeStockSharingEligibilityPayload,
  ChangeStockSharingEligibilityResult,
} from '../../shared/actions/change-stock-sharing-eligibility.ts';
import type {
  EndStockSharingEligibilityPayload,
  EndStockSharingEligibilityResult,
} from '../../shared/actions/end-stock-sharing-eligibility.ts';
import { StockSharingEligibilityLifecycleRejected } from '../../shared/actions/establish-stock-sharing-eligibility.ts';
import type {
  EstablishStockSharingEligibilityPayload,
  EstablishStockSharingEligibilityResult,
} from '../../shared/actions/establish-stock-sharing-eligibility.ts';
import type {
  StockSharingCommerceScopeValidator,
  StockSharingEligibility,
  StockSharingEligibilityError,
  StockSharingEligibilityPersistence,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import { StockSharingEligibilityRejected } from '../../shared/domain/stock-sharing-eligibility.ts';
import { StockSharingEligibilityUnavailable } from '../../shared/domain/stock-sharing-eligibility-unavailable.ts';
import { stockSharingEligibilityPersistenceForScope } from '../persistence/stock-sharing-eligibility-repository.ts';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This #851 lifecycle boundary composes the existing owner service inside the Core-provided transaction-scoped Action factory; expires: 2027-03-31.
import { makeStockSharingEligibilityService } from './stock-sharing-eligibility-service.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type LifecycleFailure = StockSharingEligibilityError | StockSharingEligibilityLifecycleRejected;

class StockSharingCommerceScopeValidatorService extends Context.Service<
  StockSharingCommerceScopeValidatorService,
  StockSharingCommerceScopeValidator
>()('@app/inventory/services/stock-sharing-eligibility-action.service/StockSharingCommerceScopeValidatorService') {}

const unavailable = () =>
  new StockSharingEligibilityUnavailable({
    code: 'stock_sharing_eligibility_unavailable',
    reason: 'Stock Sharing Eligibility persistence or owner validation is temporarily unavailable',
  });

export const unavailableStockSharingCommerceScopeValidator: StockSharingCommerceScopeValidator = Object.freeze({
  validateCurrent: () => Effect.fail(unavailable()),
});

export const stockSharingEligibilityAuditEvidence = (
  relation: StockSharingEligibility,
  operation: 'CHANGE' | 'END' | 'ESTABLISH',
) => {
  const required = {
    channel: relation.subject.channel,
    customerConfigurationId: relation.scope.customerConfigurationId,
    operation,
    ownerConfigurationId: relation.scope.ownerConfigurationRef.resourceId,
    positionId: relation.scope.positionRef.resourceId,
    relationId: relation.ref.resourceId,
    sellingLegalEntityId: relation.subject.sellingLegalEntityRef.resourceId,
  };
  const commerceMarketId = relation.subject.commerceMarketRef?.resourceId;
  const storefrontAppId = relation.subject.storefrontRef?.appId;
  if (commerceMarketId === undefined) {
    if (storefrontAppId === undefined) {
      return required;
    }
    return { ...required, storefrontAppId };
  }
  if (storefrontAppId === undefined) {
    return { ...required, commerceMarketId };
  }
  return { ...required, commerceMarketId, storefrontAppId };
};

const lifecycleRejected = (reason: StockSharingEligibilityLifecycleRejected['reason']) =>
  new StockSharingEligibilityLifecycleRejected({
    code: 'stock_sharing_eligibility_lifecycle_rejected',
    reason,
  });

const relationNotFound = (relationRef: StockSharingEligibility['ref']) =>
  new StockSharingEligibilityRejected({
    code: 'stock_sharing_eligibility_rejected',
    reason: 'RELATION_NOT_FOUND',
    relationRef,
  });

const samePosition = (
  left: StockSharingEligibility['scope']['positionRef'],
  right: StockSharingEligibility['scope']['positionRef'],
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const requireTrustedSeller = (relation: Pick<StockSharingEligibility, 'subject'>, trustedLegalEntityId: string) =>
  relation.subject.sellingLegalEntityRef.resourceId === trustedLegalEntityId
    ? Effect.void
    : Effect.fail(lifecycleRejected('TRUSTED_LEGAL_ENTITY_MISMATCH'));

const requireExistingRelation = (
  persistence: StockSharingEligibilityPersistence,
  relationRef: StockSharingEligibility['ref'],
) =>
  persistence.findByRef(relationRef).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(relationNotFound(relationRef)),
        onSome: Effect.succeed,
      }),
    ),
  );

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- This transaction-scoped factory result is embedded directly in ActionHandlerContext; the separately injected Commerce validator above owns the runtime Context identity; expires: 2027-03-31.
export interface StockSharingEligibilityActionService {
  readonly change: (
    payload: ChangeStockSharingEligibilityPayload,
    trustedLegalEntityId: string,
  ) => Effect.Effect<ChangeStockSharingEligibilityResult, LifecycleFailure>;
  readonly end: (
    payload: EndStockSharingEligibilityPayload,
    trustedLegalEntityId: string,
  ) => Effect.Effect<EndStockSharingEligibilityResult, LifecycleFailure>;
  readonly establish: (
    payload: EstablishStockSharingEligibilityPayload,
    trustedLegalEntityId: string,
  ) => Effect.Effect<EstablishStockSharingEligibilityResult, LifecycleFailure>;
}

export const makeStockSharingEligibilityActionService = (dependencies: {
  readonly commerceValidator: StockSharingCommerceScopeValidator;
  readonly makeEligibilityId: () => string;
  readonly persistence: StockSharingEligibilityPersistence;
}): StockSharingEligibilityActionService => {
  const { persistence } = dependencies;
  const lifecycle = makeStockSharingEligibilityService(dependencies);

  return Object.freeze({
    change: Effect.fn('StockSharingEligibilityActionService.change')(function* change(
      payload: ChangeStockSharingEligibilityPayload,
      trustedLegalEntityId: string,
    ) {
      const current = yield* requireExistingRelation(persistence, payload.relationRef);
      if (!samePosition(current.scope.positionRef, payload.positionRef)) {
        return yield* lifecycleRejected('POSITION_SCOPE_MISMATCH');
      }
      yield* requireTrustedSeller(current, trustedLegalEntityId);
      yield* requireTrustedSeller(payload, trustedLegalEntityId);
      return yield* lifecycle.change(payload);
    }),
    end: Effect.fn('StockSharingEligibilityActionService.end')(function* end(
      payload: EndStockSharingEligibilityPayload,
      trustedLegalEntityId: string,
    ) {
      const current = yield* requireExistingRelation(persistence, payload.relationRef);
      if (!samePosition(current.scope.positionRef, payload.positionRef)) {
        return yield* lifecycleRejected('POSITION_SCOPE_MISMATCH');
      }
      yield* requireTrustedSeller(current, trustedLegalEntityId);
      return yield* lifecycle.end(payload);
    }),
    establish: Effect.fn('StockSharingEligibilityActionService.establish')(function* establish(
      payload: EstablishStockSharingEligibilityPayload,
      trustedLegalEntityId: string,
    ) {
      yield* requireTrustedSeller(payload, trustedLegalEntityId);
      return yield* lifecycle.establish(payload);
    }),
  });
};

export const stockSharingEligibilityActionServiceForScope = Effect.fn('StockSharingEligibilityActionService.forScope')(
  function* forScope(
    transaction: ScopedTransaction,
    operationScope: OperationalScope,
    makeEligibilityId: () => string,
  ) {
    const validator = yield* Effect.serviceOption(StockSharingCommerceScopeValidatorService);
    return makeStockSharingEligibilityActionService({
      commerceValidator: Option.getOrElse(validator, () => unavailableStockSharingCommerceScopeValidator),
      makeEligibilityId,
      persistence: stockSharingEligibilityPersistenceForScope(transaction, operationScope),
    });
  },
);
