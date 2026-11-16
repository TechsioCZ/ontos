import { Effect, Option } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { DecisionAuthorityPort } from '../decision/authority.ts';
import type { AccessDecision } from '../decision/contract.ts';
import { LegalEntityIdSchema, TenantIdSchema } from '../ids.ts';
import { seamRefusal, seamUnavailable } from './decisions.ts';

/** The refusal of a request that pairs a tenant with a company it does not own. */
export const SCOPE_MISMATCH = 'deny.scope_mismatch';
const OWNERSHIP_UNAVAILABLE = 'unavailable.intent';

/**
 * The one company-of-tenant rule of every gate path (O66, O88): a request that names a company is decided only when
 * that company is one of the asked tenant's own. It applies whatever the request is decided in — the company context,
 * the tenant context with a named company, a workload's binding, a module call's subject, an inspection or an
 * approval's re-check — so no path can be asked about another tenant's company.
 *
 * `undefined` when no company is named or the company is the tenant's; otherwise the refusal (`deny.scope_mismatch`),
 * or UNAVAILABLE when ownership cannot be read (never an allow, never a plain denial).
 */
export const companyOwnershipRefusalOf = Effect.fn('AccessDecisionGate.companyOwnership')(
  function* companyOwnershipRefusalOf(
    authority: Pick<DecisionAuthorityPort, 'readCompanyOwnership'>,
    /** The asked tenant and the company the request names, if any. */
    scope: { readonly legalEntityId?: string | undefined; readonly tenantId: OperationalScope['tenantId'] },
  ): Effect.fn.Return<AccessDecision | undefined> {
    if (scope.legalEntityId === undefined) {
      return undefined;
    }
    const owned = yield* Effect.option(
      authority.readCompanyOwnership({
        legalEntityId: LegalEntityIdSchema.make(scope.legalEntityId),
        tenantId: TenantIdSchema.make(scope.tenantId),
      }),
    );
    if (Option.isNone(owned)) {
      return seamUnavailable(OWNERSHIP_UNAVAILABLE);
    }
    return owned.value ? undefined : seamRefusal(SCOPE_MISMATCH);
  },
);
