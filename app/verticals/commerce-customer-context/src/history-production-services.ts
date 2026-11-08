import type { OperationalScope } from '@app/core-runtime';
import { ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import type { Exit } from 'effect';
import { HistoryOwnerUnavailable } from '../shared/domain/history-errors.ts';
import type { CustomerHistoryPorts } from '../shared/domain/history-ports.ts';
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

type AssociationReader = CustomerHistoryPorts['counterpartyProfiles']['current'];
type AssociationRefs = Parameters<AssociationReader>[0];

export interface PreloadedCounterpartyAssociation {
  readonly outcome: Exit.Exit<Effect.Success<ReturnType<AssociationReader>>, HistoryOwnerUnavailable>;
  readonly refs: AssociationRefs;
  readonly scope: Pick<OperationalScope, 'tenantId' | 'legalEntityId' | 'principalId'>;
}

/** The owner-local association is the only SQL dependency of history composition. */
export const counterpartyAssociationReader = (
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
): AssociationReader => {
  const profiles = profilePersistenceServicesForTransaction(transaction, scope);
  return (input) => {
    if (input.counterpartyRef.tenantId !== scope.tenantId || input.profileRef.tenantId !== scope.tenantId) {
      return Effect.succeed('ABSENT');
    }
    return profiles.customerProfileRead
      .readProfile(
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
};

/** Remote history owners run only after the load transaction has committed. */
export const customerHistoryPortsAfterCommit = (
  base: CustomerHistoryPorts,
  loaded: PreloadedCounterpartyAssociation | undefined,
  scope: OperationalScope,
): Effect.Effect<CustomerHistoryPorts> =>
  Effect.succeed({
    ...base,
    counterpartyProfiles: {
      current: (input) =>
        loaded !== undefined &&
        scope.legalEntityId !== undefined &&
        scope.tenantId === loaded.scope.tenantId &&
        scope.legalEntityId === loaded.scope.legalEntityId &&
        scope.principalId === loaded.scope.principalId &&
        input.counterpartyRef.tenantId === scope.tenantId &&
        input.profileRef.tenantId === scope.tenantId &&
        exactRef(input.counterpartyRef, loaded.refs.counterpartyRef) &&
        exactRef(input.profileRef, loaded.refs.profileRef)
          ? loaded.outcome
          : Effect.fail(unavailable('commerce.customer-context')),
    },
  });

/** Transaction-local association used by the history Action's owner adapter. */
export const customerHistoryPortsForOperation = (
  base: CustomerHistoryPorts,
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<CustomerHistoryPorts> =>
  Effect.succeed({
    ...base,
    counterpartyProfiles: {
      current:
        scope.legalEntityId === undefined
          ? () => Effect.succeed('INDETERMINATE' as const)
          : counterpartyAssociationReader(transaction, { ...scope, legalEntityId: scope.legalEntityId }),
    },
  });
