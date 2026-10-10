import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';

import {
  TaxGovernanceConflict,
  TaxGovernanceNotFound,
  TaxGovernanceStaleBasis,
} from '../../shared/domain/tax-governance-errors.ts';
import type {
  GovernanceConflict,
  GovernanceNotFound,
  GovernanceStale,
  GovernedInvocation,
} from '../services/tax-governance-persistence.ts';

/**
 * Trusted Core attribution; the Selling Legal Entity comes only from the Operational Scope (#950 F24-F28) and the
 * operation time only from the server clock, never from the client.
 */
export const governedInvocation = Effect.fn('TaxGovernance.governedInvocation')(
  function* governedInvocationEffect(context: {
    readonly actionInvocationId: string;
    readonly scope: OperationalScope;
  }) {
    const operationTime = yield* DateTime.nowAsDate;
    return {
      actionInvocationId: context.actionInvocationId,
      actorPrincipalId: context.scope.principalId,
      legalEntityId: context.scope.legalEntityId ?? '',
      operationTime,
      tenantId: context.scope.tenantId,
    } satisfies GovernedInvocation;
  },
);

/** Maps a rejected governed mutation to its typed domain error; canonical state is unchanged (#955). */
export const failGovernance = (outcome: GovernanceConflict | GovernanceNotFound | GovernanceStale, subject: string) => {
  if (outcome.kind === 'stale_basis') {
    return Effect.fail(
      new TaxGovernanceStaleBasis({
        code: 'tax_governance_stale_basis',
        reason: `The expected ${subject} basis is no longer current`,
      }),
    );
  }
  if (outcome.kind === 'not_found') {
    return Effect.fail(
      new TaxGovernanceNotFound({ code: 'tax_governance_not_found', reason: `The ${subject} does not exist` }),
    );
  }
  return Effect.fail(
    new TaxGovernanceConflict({
      code: 'tax_governance_conflict',
      conflict: outcome.conflict,
      reason: `The ${subject} change conflicts with durable Tax governance state`,
    }),
  );
};
