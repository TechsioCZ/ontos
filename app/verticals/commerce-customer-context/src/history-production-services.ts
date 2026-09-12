import type { OperationalScope } from '@app/core-runtime';
import { ContextAccess, ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';
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

/** Adds owner-local profile association and Core Resource authorization to external history ports. */
export const customerHistoryPortsForOperation = Effect.fn('CustomerHistoryProduction.customerHistoryPortsForOperation')(
  function* productionPorts(
    base: CustomerHistoryPorts,
    transaction: ProfileScopedRoutineInvoker,
    scope: OperationalScope,
  ) {
    if (scope.legalEntityId === undefined) {
      return base;
    }
    const trustedScope = { ...scope, legalEntityId: scope.legalEntityId };
    const profiles = profilePersistenceServicesForTransaction(transaction, trustedScope);
    const contextAccess = yield* Effect.serviceOption(ContextAccess);
    return {
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
      resources: Option.match(contextAccess, {
        onNone: () => base.resources,
        onSome: (service) => currentResourceAccess(trustedScope, service),
      }),
    } satisfies CustomerHistoryPorts;
  },
);
