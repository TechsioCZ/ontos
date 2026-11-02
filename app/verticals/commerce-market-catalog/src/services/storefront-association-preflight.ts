import type { ActionServiceFactory, ActionServicePreflight, ActionServicePreparationContext } from '@app/core-runtime';
import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { StorefrontApplicationIdSchema } from '@app/storefront-registry-contracts';
import { DateTime, Effect, Schema } from 'effect';
import type { CurrentStorefrontApplicationRequest } from '@app/storefront-registry-contracts';
import type { AssociateStorefrontPayload, ReviseStorefrontAssociationPayload } from '../../shared/action-contracts.ts';
import type {
  CurrentStorefrontApplicationAuthority,
  CurrentStorefrontApplicationEvidence,
  StorefrontApplicationValidationFailure,
} from '../integrations/current-storefront-application.ts';
import {
  StorefrontApplicationEvidenceStale,
  StorefrontApplicationNotCurrent,
  StorefrontApplicationValidationUnavailable,
  makeServerCurrentStorefrontApplicationAuthority,
} from '../integrations/current-storefront-application.ts';
import type { MarketAdministrationService } from './market-administration.service.ts';
import {
  MarketAdministrationPersistenceUnavailable,
  marketAdministrationService,
} from './market-administration.service.ts';

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);

type AssociateStorefrontServices = MarketAdministrationService & CurrentStorefrontApplicationAuthority;

/** An exact, short-lived owner observation; an unexpected selector never falls back to HTTP. */
export const preparedStorefrontApplicationAuthority = (
  request: CurrentStorefrontApplicationRequest,
  requestCorrelation: string,
  evidence: CurrentStorefrontApplicationEvidence,
  preparedAt: DateTime.Utc,
): CurrentStorefrontApplicationAuthority => {
  const validateCurrent: CurrentStorefrontApplicationAuthority['validateCurrent'] = Effect.fn(
    'AssociateStorefrontAction.validatePreparedStorefront',
  )(function* validatePreparedStorefront(input, correlation) {
    const instant = yield* DateTime.now;
    const now = DateTime.formatIso(instant);
    const age = DateTime.toEpochMillis(instant) - DateTime.toEpochMillis(preparedAt);
    if (
      age < 0 ||
      age >= 30_000 ||
      correlation !== requestCorrelation ||
      input.effectiveAt !== request.effectiveAt ||
      input.requestedChannel !== request.requestedChannel ||
      input.storefrontAppId !== request.storefrontAppId ||
      input.tenantId !== request.tenantId ||
      (evidence.nextApplicabilityBoundary !== undefined && evidence.nextApplicabilityBoundary <= now)
    ) {
      return yield* new StorefrontApplicationEvidenceStale({
        code: 'storefront_application_evidence_stale',
        reason: 'The exact prepared Storefront application evidence is no longer usable',
      });
    }
    return evidence;
  });
  return { validateCurrent };
};

export const prepareStorefrontAssociationServices: ActionServicePreflight<
  AssociateStorefrontPayload | ReviseStorefrontAssociationPayload,
  AssociateStorefrontServices,
  StorefrontApplicationValidationFailure
> = Effect.fn('AssociateStorefrontAction.prepareServices')(function* prepareServices(
  payload: AssociateStorefrontPayload | ReviseStorefrontAssociationPayload,
  context: ActionServicePreparationContext,
) {
  const request = {
    effectiveAt: DateTime.formatIso(payload.effectivePeriod.startsAt),
    requestedChannel: payload.channel,
    storefrontAppId: yield* Schema.decodeEffect(StorefrontApplicationIdSchema)(payload.storefrontRef.appId).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          new StorefrontApplicationValidationUnavailable({
            code: 'storefront_application_validation_unavailable',
            reason: 'The Storefront application identifier could not be validated for owner lookup',
          }),
          'cause',
          { value: cause },
        ),
      ),
    ),
    tenantId: payload.storefrontRef.tenantId,
  };
  if (request.tenantId !== context.scope.tenantId) {
    return yield* new StorefrontApplicationNotCurrent({
      code: 'storefront_application_not_current',
      reason: 'The Storefront application must belong to the trusted Tenant',
    });
  }
  const authority = makeServerCurrentStorefrontApplicationAuthority({
    compositionRevision: context.compositionRevision,
    legalEntityId: context.scope.legalEntityId,
  });
  const preparedAt = yield* DateTime.now;
  const evidence = yield* authority.validateCurrent(request, context.scope.correlationId);
  const { validateCurrent } = preparedStorefrontApplicationAuthority(
    request,
    context.scope.correlationId,
    evidence,
    preparedAt,
  );
  const factory: ActionServiceFactory<AssociateStorefrontServices> = Effect.fn('StorefrontAssociation.commitServices')(
    function* commitServices(transaction, scope, revision) {
      if (
        scope.tenantId !== context.scope.tenantId ||
        scope.legalEntityId !== context.scope.legalEntityId ||
        !samePrincipal(scope, context.scope) ||
        scope.correlationId !== context.scope.correlationId ||
        revision !== context.compositionRevision
      ) {
        return yield* new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Prepared Storefront evidence belongs to another operation context',
        });
      }
      const catalog = yield* marketAdministrationService(transaction, scope);
      return {
        ...catalog,
        associateStorefront: (input) =>
          input.actionInvocationId === context.actionInvocationId && input.principalId === scope.principalId
            ? catalog.associateStorefront(input)
            : Effect.fail(
                new MarketAdministrationPersistenceUnavailable({
                  code: 'market_administration_persistence_unavailable',
                  reason: 'Prepared Storefront evidence belongs to another invocation',
                }),
              ),
        reviseStorefrontAssociation: (input) =>
          input.actionInvocationId === context.actionInvocationId && input.principalId === scope.principalId
            ? catalog.reviseStorefrontAssociation(input)
            : Effect.fail(
                new MarketAdministrationPersistenceUnavailable({
                  code: 'market_administration_persistence_unavailable',
                  reason: 'Prepared Storefront evidence belongs to another invocation',
                }),
              ),
        validateCurrent,
      } satisfies AssociateStorefrontServices;
    },
  );
  return factory;
});
