import { Effect, Option, Result } from 'effect';

import type { DecisionAuthorityPort } from '../decision/authority.ts';
import { holderIdOf } from '../decision/selector.ts';

type ScopeRead = DecisionAuthorityPort['readScope'];

/** One scope read's identity: its tenant, company context, checked company and holders. */
export const scopeReadKey = (query: Parameters<ScopeRead>[0], checkedCompany: string): string =>
  [query.tenantId, query.legalEntityId ?? '', checkedCompany, ...query.holders.map(holderIdOf)].join('\u0000');

/**
 * Scope reads of one call or one inspection, over a read already shared per distinct question. A tenant-context read
 * that checked a company and resolved IS the tenant's scope, so the same holders' read without a company (the engine's
 * own) takes that answer instead of a read of its own, as both did before the check existed. Never the reverse: an
 * unchecked answer vouches for no company, and a checked read that resolved nothing or failed leaves the unchecked
 * read to its own answer.
 */
export const checkedScopeAnswersUnchecked = (shared: ScopeRead): ScopeRead => {
  const checkedByScope = new Map<string, ReturnType<ScopeRead>>();
  return (query) => {
    const plain = scopeReadKey(query, '');
    if (query.checkedCompany !== undefined) {
      const answer = shared(query);
      if (!checkedByScope.has(plain)) {
        checkedByScope.set(plain, answer);
      }
      return answer;
    }
    const checked = checkedByScope.get(plain);
    return checked === undefined
      ? shared(query)
      : checked.pipe(
          Effect.result,
          Effect.flatMap((answer) =>
            Result.isSuccess(answer) && Option.isSome(answer.success) ? Effect.succeed(answer.success) : shared(query),
          ),
        );
  };
};
