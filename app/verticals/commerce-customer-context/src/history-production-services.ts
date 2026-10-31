import type { OperationalScope } from '@app/core-runtime';
import { ContextAccess, ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';
import type { Exit } from 'effect';
import { HistoryOwnerUnavailable } from '../shared/domain/history-errors.ts';
import type { CustomerHistoryPorts, HistoricalResourceAccessPort } from '../shared/domain/history-ports.ts';
import { profilePersistenceServicesForTransaction } from './persistence/profile-persistence.ts';
import type { ProfileScopedRoutineInvoker } from './persistence/profile-persistence.ts';

const unavailable = (ownerModuleId: string) => new HistoryOwnerUnavailable({ ownerModuleId });

const exactRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const currentResourceAccess = (
  scope: OperationalScope & { readonly legalEntityId: string },
  contextAccess: typeof ContextAccess.Service,
): HistoricalResourceAccessPort => ({
  current: ({ principalId, refs }) => {
    if (principalId !== scope.principalId || refs.some((ref) => ref.tenantId !== scope.tenantId)) {
      return Effect.succeed('ABSENT');
    }
    return contextAccess
      .resources({
        legalEntityId: scope.legalEntityId,
        permission: 'read',
        principalId,
        resources: refs,
        tenantId: scope.tenantId,
      })
      .pipe(
        Effect.map((decisions) => {
          const malformed =
            decisions.length !== refs.length ||
            decisions.some(({ key }, index) => {
              const ref = refs[index];
              return ref === undefined || key !== `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`;
            });
          if (malformed || decisions.some(({ decision }) => decision === 'unavailable')) {
            return 'INDETERMINATE' as const;
          }
          return decisions.some(({ decision }) => decision === 'denied') ? ('ABSENT' as const) : ('CURRENT' as const);
        }),
      );
  },
});

export type CounterpartyAssociationRefs = Parameters<CustomerHistoryPorts['counterpartyProfiles']['current']>[0];
type CounterpartyAssociationState = Effect.Success<ReturnType<CustomerHistoryPorts['counterpartyProfiles']['current']>>;

/**
 * Read in the transaction: the owner-local association a history request names, kept as an outcome so the
 * composition after commit meets it (or its unavailability) in the same order it always did.
 */
export interface PreloadedCounterpartyAssociation {
  readonly outcome: Exit.Exit<CounterpartyAssociationState, HistoryOwnerUnavailable>;
  readonly refs: CounterpartyAssociationRefs;
}

/** Owner-local Counterparty ↔ purchasing-profile association, from the Read's own transaction (database only). */
export const counterpartyAssociationReader =
  (transaction: ProfileScopedRoutineInvoker, scope: OperationalScope & { readonly legalEntityId: string }) =>
  (input: CounterpartyAssociationRefs): Effect.Effect<CounterpartyAssociationState, HistoryOwnerUnavailable> => {
    if (input.counterpartyRef.tenantId !== scope.tenantId || input.profileRef.tenantId !== scope.tenantId) {
      return Effect.succeed('ABSENT');
    }
    return profilePersistenceServicesForTransaction(transaction, scope)
      .customerProfileRead.readProfile(
        {
          authorizationSubject: {
            counterpartyRef: input.counterpartyRef,
            kind: 'COUNTERPARTY',
          },
          profileRef: { ...input.profileRef, kind: 'COUNTERPARTY' },
        },
        scope.tenantId,
      )
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Schema.is(ReadHandlerNotFound)(error)
              ? Effect.succeed('ABSENT' as const)
              : Effect.fail(unavailable('commerce.customer-context')),
          onSuccess: (result) =>
            Effect.succeed(
              Match.value(result).pipe(
                Match.tag('PROFILE_RECONCILIATION_REQUIRED', () => 'INDETERMINATE' as const),
                Match.tag('PROFILE_AVAILABLE', ({ profile }) =>
                  profile.kind === 'COUNTERPARTY' &&
                  exactRef(profile.profileRef, input.profileRef) &&
                  exactRef(profile.subject.counterpartyRef, input.counterpartyRef)
                    ? ('CURRENT' as const)
                    : ('ABSENT' as const),
                ),
                Match.exhaustive,
              ),
            ),
        }),
      );
  };

/**
 * After commit: the deployment's external history ports, the association preloaded in the transaction, and Core
 * Resource authorization (SpiceDB). An association the request did not name is indeterminate, never assumed.
 */
export const customerHistoryPortsAfterCommit = Effect.fn('CustomerHistoryProduction.customerHistoryPortsAfterCommit')(
  function* productionPorts(
    base: CustomerHistoryPorts,
    association: PreloadedCounterpartyAssociation | undefined,
    scope: OperationalScope,
  ) {
    if (scope.legalEntityId === undefined) {
      return base;
    }
    const trustedScope = { ...scope, legalEntityId: scope.legalEntityId };
    const contextAccess = yield* Effect.serviceOption(ContextAccess);
    return {
      ...base,
      counterpartyProfiles: {
        current: (input) =>
          association !== undefined &&
          exactRef(association.refs.counterpartyRef, input.counterpartyRef) &&
          exactRef(association.refs.profileRef, input.profileRef)
            ? association.outcome
            : Effect.succeed('INDETERMINATE'),
      },
      resources: Option.match(contextAccess, {
        onNone: () => base.resources,
        onSome: (service) => currentResourceAccess(trustedScope, service),
      }),
    } satisfies CustomerHistoryPorts;
  },
);

/** For Actions, whose whole handler runs in the Action transaction: the association is read live from it. */
export const customerHistoryPortsForOperation = Effect.fn('CustomerHistoryProduction.customerHistoryPortsForOperation')(
  function* actionPorts(base: CustomerHistoryPorts, transaction: ProfileScopedRoutineInvoker, scope: OperationalScope) {
    if (scope.legalEntityId === undefined) {
      return base;
    }
    const trustedScope = { ...scope, legalEntityId: scope.legalEntityId };
    const contextAccess = yield* Effect.serviceOption(ContextAccess);
    return {
      ...base,
      counterpartyProfiles: { current: counterpartyAssociationReader(transaction, trustedScope) },
      resources: Option.match(contextAccess, {
        onNone: () => base.resources,
        onSome: (service) => currentResourceAccess(trustedScope, service),
      }),
    } satisfies CustomerHistoryPorts;
  },
);
