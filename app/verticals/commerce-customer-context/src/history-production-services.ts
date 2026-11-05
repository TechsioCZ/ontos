import type { OperationalScope } from '@app/core-runtime';
import { ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
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

/** Adds owner-local profile association to the external history ports. */
export const customerHistoryPortsForOperation = (
  base: CustomerHistoryPorts,
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<CustomerHistoryPorts> => {
  if (scope.legalEntityId === undefined) {
    return Effect.succeed(base);
  }
  const trustedScope = { ...scope, legalEntityId: scope.legalEntityId };
  const profiles = profilePersistenceServicesForTransaction(transaction, trustedScope);
  return Effect.succeed({
    ...base,
    counterpartyProfiles: {
      current: (input) => {
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
      },
    },
    // Each historical Resource is authorized by the history capability's own access gate
    // (O62); the owner no longer re-checks resource#read beside it.
    resources: base.resources,
  } satisfies CustomerHistoryPorts);
};
