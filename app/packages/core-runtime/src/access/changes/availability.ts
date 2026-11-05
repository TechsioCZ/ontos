import { Result, Schema } from 'effect';

import { AccessScopeIdSchema, CapabilityKeySchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type { PrincipalId } from '../ids.ts';
import type { Delegation } from '../model.ts';
import { DelegationSchema } from '../model.ts';
import { delegationIsLive } from './authority.ts';
import { compareText } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';

/**
 * The scope a capability is configurable in, and everyone who administers it. The scope is an
 * input, not an inference: management authority in one legal entity never makes a manager a
 * configurator of the same capability in another one (guarantee 1, R2-L1).
 */
export const ScopeAdministrationFactsSchema = Schema.Struct({
  at: Schema.Date,
  capabilityKey: CapabilityKeySchema,
  delegations: Schema.Array(DelegationSchema),
  owners: Schema.Array(PrincipalIdSchema).check(Schema.isUnique()),
  scopeAdmins: Schema.Array(PrincipalIdSchema).check(Schema.isUnique()),
  scopeId: AccessScopeIdSchema,
  tenantId: TenantIdSchema,
});
export type ScopeAdministrationFacts = typeof ScopeAdministrationFactsSchema.Type;

/**
 * The "configurable, not usable" answer for one published capability. Publication creates no cell,
 * no grant incarnation and no decision, so `usableWithoutAdoption` is structurally false and the
 * grant counters are literal zeros: there is nothing an adoption-less release could hand out.
 */
export const CapabilityAvailabilitySchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  configurableBy: Schema.Struct({
    delegatedManagers: Schema.Array(PrincipalIdSchema),
    owners: Schema.Array(PrincipalIdSchema),
    scopeAdmins: Schema.Array(PrincipalIdSchema),
  }),
  grants: Schema.Struct({ cells: Schema.Literal(0), incarnations: Schema.Literal(0) }),
  scopeId: AccessScopeIdSchema,
  tenantId: TenantIdSchema,
  usableWithoutAdoption: Schema.Literal(false),
});
export type CapabilityAvailability = typeof CapabilityAvailabilitySchema.Type;

const uniquePrincipals = (principals: readonly PrincipalId[]): readonly PrincipalId[] =>
  [...new Set(principals)].toSorted(compareText);

/** Only a delegation of this very scope, naming this capability and live now, makes a configurator. */
const liveDelegationsFor = (facts: ScopeAdministrationFacts): readonly Delegation[] =>
  facts.delegations.filter(
    (delegation) =>
      delegation.tenantId === facts.tenantId &&
      delegation.scopeId === facts.scopeId &&
      delegation.capabilityKeys.includes(facts.capabilityKey) &&
      delegationIsLive(delegation, facts.at),
  );

const grantsNothing: CapabilityAvailability['grants'] = { cells: 0, incarnations: 0 };

/**
 * Guarantee 1: a published capability is always configurable by its owner, its scope admins or a
 * delegated manager, and the guarantee is checked rather than assumed — a catalog entry nobody can
 * configure is refused instead of shipped. Bodies and title never imply data access (P3, O28), and
 * only people configure (D2): every identifier below is a human principal.
 */
export const planCapabilityAvailability = (
  facts: ScopeAdministrationFacts,
): Result.Result<CapabilityAvailability, AccessChangesError> => {
  const owners = uniquePrincipals(facts.owners);
  const scopeAdmins = uniquePrincipals(facts.scopeAdmins);
  const delegatedManagers = uniquePrincipals(liveDelegationsFor(facts).map(({ managerId }) => managerId));
  if (owners.length + scopeAdmins.length + delegatedManagers.length === 0) {
    return Result.fail(
      accessChangesError(
        'access_changes_capability_not_configurable',
        `capability ${facts.capabilityKey} would be configurable by nobody`,
      ),
    );
  }
  return Result.succeed(
    Object.freeze({
      capabilityKey: facts.capabilityKey,
      configurableBy: Object.freeze({
        delegatedManagers: Object.freeze(delegatedManagers),
        owners: Object.freeze(owners),
        scopeAdmins: Object.freeze(scopeAdmins),
      }),
      grants: Object.freeze(grantsNothing),
      scopeId: facts.scopeId,
      tenantId: facts.tenantId,
      usableWithoutAdoption: false,
    }),
  );
};
