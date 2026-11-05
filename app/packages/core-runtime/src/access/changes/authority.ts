import { Match, Option, Schema } from 'effect';

import { LegalEntityIdSchema } from '../ids.ts';
import { earliestDeadline } from '../decision/contract.ts';
import type { TenantProjectionIntent } from '../compiler/intent.ts';
import type { AccessMembership } from '../intent/memberships.ts';
import type { AccessScopeId, CapabilityKey, LegalEntityId, PrincipalId, RoleId } from '../ids.ts';
import { delegationCellIssue } from '../lifecycle/delegation.ts';
import type { DelegatedCellRequest } from '../lifecycle/delegation.ts';
import type { AccessScope, AccessScopeRecord, Delegation, Holder, Role } from '../model.ts';
import { AccessScopeRecordSchema, DelegationSchema } from '../model.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';
import { compareText } from './compare.ts';

/**
 * Why a person may configure access for one role. Owner and scope admin are management power in a
 * scope (O28); a delegated manager is bounded by an exact, never-self, never-widening envelope
 * (P8, D10). Agents appear nowhere: only people configure access (P3, D2).
 */
export const AccessConfigureBasisSchema = Schema.Union([
  Schema.TaggedStruct('Owner', {}),
  Schema.TaggedStruct('ScopeAdmin', {
    legalEntityIds: Schema.Array(LegalEntityIdSchema).check(Schema.isUnique()),
    tenantContext: Schema.Boolean,
    /** The earliest end of the admin assignment and its required tenant/company memberships. */
    deadlines: Schema.optionalKey(
      Schema.Array(Schema.Struct({ legalEntityId: LegalEntityIdSchema, until: Schema.Date })),
    ),
  }),
  Schema.TaggedStruct('DelegatedManager', {
    delegation: DelegationSchema,
    /**
     * The scope the delegation manages, resolved from its scope id. A delegation is management
     * power in exactly one context, so the basis carries it instead of inferring it from a role.
     */
    scope: AccessScopeRecordSchema,
  }),
]);
export type AccessConfigureBasis = typeof AccessConfigureBasisSchema.Type;

/** A cell a decision writes into one role, with the published entry that declares it (R2-H4). */
export type GrantedCell = Omit<DelegatedCellRequest, 'delegation'>;

/** Agents never administer access, whatever they are granted (D2). */
export const deciderIssue = (actor: Holder): string | null =>
  Match.value(actor).pipe(
    Match.tags({
      Agent: () => 'an agent never decides access changes; only a person configures access',
      Principal: () => null,
    }),
    Match.exhaustive,
  );

export const delegationIsLive = (delegation: Delegation, at: Date): boolean =>
  delegation.status === 'active' && delegation.validFrom <= at && at < delegation.validUntil;

/** Period and holder matching, including suspended rows that must subtract authority. */
const isCurrentMembershipOf = (membership: AccessMembership, actor: PrincipalId, at: Date): boolean =>
  membership.validFrom <= at &&
  (membership.validUntil === undefined || at < membership.validUntil) &&
  Match.value(membership.holder).pipe(
    Match.tags({ Agent: () => false, Principal: ({ principalId }) => principalId === actor }),
    Match.exhaustive,
  );

/** One live `access_admin` assignment is necessary but not sufficient for administration. */
const isLiveAccessAdminOf = (membership: AccessMembership, actor: PrincipalId, at: Date): boolean =>
  membership.kind === 'access_admin' && membership.status === 'active' && isCurrentMembershipOf(membership, actor, at);

/** A map entry proves exact-scope membership; undefined means that membership has no deadline. */
const memberDeadlinesOf = (input: {
  readonly actor: PrincipalId;
  readonly at: Date;
  readonly memberships: readonly AccessMembership[];
}): ReadonlyMap<AccessScopeId, Date | undefined> => {
  const members = new Map<AccessScopeId, Date | undefined>();
  const suspended = new Set<AccessScopeId>();
  for (const membership of input.memberships) {
    if (!isCurrentMembershipOf(membership, input.actor, input.at)) {
      continue;
    }
    if (membership.status === 'suspended') {
      suspended.add(membership.scopeId);
    } else if (membership.kind === 'member' && membership.status === 'active') {
      members.set(membership.scopeId, earliestDeadline([members.get(membership.scopeId), membership.validUntil]));
    }
  }
  for (const scopeId of suspended) {
    members.delete(scopeId);
  }
  return members;
};

/** The company one scope administers, or none for the tenant context itself. */
const administeredCompanyOf = (record: AccessScopeRecord): Option.Option<LegalEntityId> =>
  Match.value(record.scope).pipe(
    Match.tags({
      LegalEntity: ({ legalEntityId }) => Option.some(LegalEntityIdSchema.make(legalEntityId)),
      TenantContext: () => Option.none<LegalEntityId>(),
    }),
    Match.exhaustive,
  );

/** Whether one scope is the tenant context: the one context O81 refuses a company admin membership in. */
const administersTenant = (record: AccessScopeRecord): boolean =>
  Match.value(record.scope).pipe(Match.tags({ LegalEntity: () => false, TenantContext: () => true }), Match.exhaustive);

/** The `access_admin` part of O81's basis: the companies and the tenant this person administers. */
const scopeAdminBasisOf = (input: {
  readonly actor: PrincipalId;
  readonly at: Date;
  readonly memberDeadlines: ReadonlyMap<AccessScopeId, Date | undefined>;
  readonly memberships: readonly AccessMembership[];
  readonly scopes: ReadonlyMap<AccessScopeId, AccessScopeRecord>;
  readonly tenantDeadline: Date | undefined;
}): AccessConfigureBasis | undefined => {
  const legalEntityIds = new Set<LegalEntityId>();
  // The earliest end of any access-admin membership per company: a later row never extends it.
  const deadlines = new Map<LegalEntityId, Date>();
  let tenantContext = false;
  for (const membership of input.memberships) {
    const record = input.scopes.get(membership.scopeId);
    if (
      record === undefined ||
      !input.memberDeadlines.has(membership.scopeId) ||
      !isLiveAccessAdminOf(membership, input.actor, input.at)
    ) {
      continue;
    }
    const company = Option.getOrUndefined(administeredCompanyOf(record));
    if (company !== undefined) {
      legalEntityIds.add(company);
      const deadline = earliestDeadline([
        deadlines.get(company),
        membership.validUntil,
        input.memberDeadlines.get(membership.scopeId),
        input.tenantDeadline,
      ]);
      if (deadline !== undefined) {
        deadlines.set(company, deadline);
      }
    }
    tenantContext ||= administersTenant(record);
  }
  if (legalEntityIds.size === 0 && !tenantContext) {
    return undefined;
  }
  return {
    _tag: 'ScopeAdmin',
    deadlines: [...deadlines].map(([legalEntityId, until]) => ({ legalEntityId, until })),
    legalEntityIds: [...legalEntityIds],
    tenantContext,
  };
};

/** The management power a person reaches in one scope, from live intent only (P8, D10, O81). */
const delegatedBasesOf = (input: {
  readonly actor: PrincipalId;
  readonly at: Date;
  readonly intent: TenantProjectionIntent;
  readonly memberDeadlines: ReadonlyMap<AccessScopeId, Date | undefined>;
}): readonly AccessConfigureBasis[] =>
  [...input.intent.scopes]
    .filter(({ scope }) => input.memberDeadlines.has(scope.id))
    .toSorted((left, right) => compareText(left.scope.id, right.scope.id))
    .flatMap(({ delegations, scope }) =>
      [...delegations]
        .toSorted((left, right) => compareText(left.id, right.id))
        .flatMap((delegation): readonly AccessConfigureBasis[] =>
          delegation.managerId === input.actor && delegationIsLive(delegation, input.at)
            ? [{ _tag: 'DelegatedManager', delegation, scope }]
            : [],
        ),
    );

/** One source of configure authority for both change commands and admin-key admission (O81). */
export const configureBasesOf = (input: {
  readonly actor: PrincipalId;
  readonly at: Date;
  readonly intent: TenantProjectionIntent;
  readonly memberships: readonly AccessMembership[];
}): readonly AccessConfigureBasis[] => {
  const scopes = new Map(input.intent.scopes.map(({ scope }) => [scope.id, scope]));
  const tenantScope = [...scopes.values()].find(administersTenant);
  const memberships = input.memberships.filter((membership) => membership.tenantId === input.intent.tenantId);
  const memberDeadlines = memberDeadlinesOf({ actor: input.actor, at: input.at, memberships });
  // Every management path needs tenant access. Owners inherit company administration without a
  // company membership; company admins and delegates additionally need membership in their scope.
  if (tenantScope === undefined || !memberDeadlines.has(tenantScope.id)) {
    return Object.freeze([]);
  }
  const scopeAdmin = scopeAdminBasisOf({
    actor: input.actor,
    at: input.at,
    memberDeadlines,
    memberships,
    scopes,
    tenantDeadline: memberDeadlines.get(tenantScope.id),
  });
  const owner = input.intent.owners.includes(input.actor);
  return Object.freeze([
    ...(owner ? [{ _tag: 'Owner' } as const] : []),
    ...(scopeAdmin === undefined ? [] : [scopeAdmin]),
    ...delegatedBasesOf({ ...input, memberDeadlines }),
  ]);
};

/** Whether one basis reaches the admin key in this scope: the whole O81 union, never a superset. */
const basisCoversKey = (
  basis: AccessConfigureBasis,
  scope: AccessScopeRecord,
  capabilityKey: CapabilityKey,
  at: Date,
): boolean =>
  Match.value(basis).pipe(
    Match.tags({
      DelegatedManager: ({ delegation, scope: managedScope }) =>
        managedScope.id === scope.id &&
        delegationIsLive(delegation, at) &&
        delegation.capabilityKeys.includes(capabilityKey),
      Owner: () => true,
      ScopeAdmin: ({ deadlines, legalEntityIds }) =>
        Match.value(scope.scope).pipe(
          Match.tags({
            LegalEntity: ({ legalEntityId }) => {
              const company = LegalEntityIdSchema.make(legalEntityId);
              const deadline = deadlines?.find((one) => one.legalEntityId === company)?.until;
              return new Set<LegalEntityId>(legalEntityIds).has(company) && (deadline === undefined || at < deadline);
            },
            TenantContext: () => false,
          }),
          Match.exhaustive,
        ),
    }),
    Match.exhaustive,
  );

/** A structural basis is usable only in this scope and for this admin key (D10, O28, O81). */
export const configureBasisFor = (
  bases: readonly AccessConfigureBasis[],
  scope: AccessScopeRecord,
  capabilityKey: CapabilityKey,
  at: Date,
): AccessConfigureBasis | undefined => bases.find((basis) => basisCoversKey(basis, scope, capabilityKey, at));

/** The delegation a basis relies on, or undefined when that delegation has lapsed (D10). */
export const liveDelegation = (basis: AccessConfigureBasis, at: Date): Delegation | null =>
  Match.value(basis).pipe(
    Match.tags({
      DelegatedManager: ({ delegation }) => (delegationIsLive(delegation, at) ? delegation : null),
      Owner: () => null,
      ScopeAdmin: () => null,
    }),
    Match.exhaustive,
  );

/** A role lives in exactly one context: tenant-wide, or one legal entity (O7). */
export const roleInScope = (scope: AccessScope, role: Role): boolean =>
  Match.value(scope).pipe(
    Match.tags({
      LegalEntity: ({ legalEntityId }) => role.legalEntityId === legalEntityId,
      TenantContext: () => role.legalEntityId === undefined,
    }),
    Match.exhaustive,
  );

/**
 * Configuration authority for one role: an owner covers the whole tenant, a scope admin covers the
 * context they administer, and a delegated manager covers exactly the roles of their envelope. The
 * envelope's own scope, ceiling and cell rules are checked by `delegationEnvelopeIssue`, so a role
 * outside the delegation is reported as the delegation refusal it is, not as a missing right.
 */
export const configureBasisCoversRole = (basis: AccessConfigureBasis, role: Role): boolean =>
  Match.value(basis).pipe(
    Match.tags({
      DelegatedManager: ({ delegation }) => delegation.roleIds.includes(role.id),
      Owner: () => true,
      ScopeAdmin: ({ legalEntityIds, tenantContext }) =>
        role.legalEntityId === undefined ? tenantContext : legalEntityIds.includes(role.legalEntityId),
    }),
    Match.exhaustive,
  );

export interface DelegationEnvelopeCheck {
  /** The scopes of the assignments the decision reaches; a delegation reaches only its own scope. */
  readonly affectedAssignmentScopeIds: readonly AccessScopeId[];
  readonly affectedHolderPrincipals: readonly PrincipalId[];
  readonly at: Date;
  readonly capabilityKeys: readonly CapabilityKey[];
  readonly delegation: Delegation;
  /** The exact cells the decision grants, each checked with the lifecycle's one ceiling rule (D10b). */
  readonly grantedCells: readonly GrantedCell[];
  readonly roles: readonly Role[];
  readonly scope: AccessScopeRecord;
  readonly tenantId: string;
}

/**
 * The exact envelope, never the module name (P8): a capability the delegation did not name is out
 * of scope even when it belongs to "their" module, so a new permission is a new decision. The
 * delegation reaches its own scope only — a role of another legal entity, an assignment there, a
 * cell outside its ceilings and a money cell without a limit are all refusals (R2-H4, guarantee 7).
 */
export const delegationEnvelopeIssue = (check: DelegationEnvelopeCheck): string | undefined => {
  const { delegation, scope } = check;
  if (!delegationIsLive(delegation, check.at)) {
    return `delegation ${delegation.id} is not live at the time of the decision`;
  }
  if (delegation.tenantId !== check.tenantId) {
    return `delegation ${delegation.id} belongs to another tenant`;
  }
  if (scope.id !== delegation.scopeId) {
    return `delegation ${delegation.id} manages scope ${delegation.scopeId}, not ${scope.id}`;
  }
  const outsideScopeRole = check.roles.find((role) => !roleInScope(scope.scope, role));
  if (outsideScopeRole !== undefined) {
    return `role ${outsideScopeRole.name} does not live in the scope of delegation ${delegation.id}`;
  }
  const outsideScopeAssignment = check.affectedAssignmentScopeIds.find((scopeId) => scopeId !== delegation.scopeId);
  if (outsideScopeAssignment !== undefined) {
    return `assignment scope ${outsideScopeAssignment} is outside delegation ${delegation.id}`;
  }
  const capabilities = new Set<CapabilityKey>(delegation.capabilityKeys);
  const outsideCapability = check.capabilityKeys.find((key) => !capabilities.has(key));
  if (outsideCapability !== undefined) {
    return `capability ${outsideCapability} is outside delegation ${delegation.id}; extending a delegation is a new decision`;
  }
  const roles = new Set<RoleId>(delegation.roleIds);
  const outsideRole = check.roles.find((role) => !roles.has(role.id));
  if (outsideRole !== undefined) {
    return `role ${outsideRole.id} is outside delegation ${delegation.id}`;
  }
  const people = new Set<PrincipalId>(delegation.people);
  const outsidePerson = check.affectedHolderPrincipals.find((personId) => !people.has(personId));
  if (outsidePerson !== undefined) {
    return `holder ${outsidePerson} is outside delegation ${delegation.id}`;
  }
  if (check.affectedHolderPrincipals.includes(delegation.managerId)) {
    return 'a delegate never assigns access to themselves';
  }
  for (const granted of check.grantedCells) {
    const issue = delegationCellIssue({ ...granted, delegation });
    if (issue !== undefined) {
      return `${issue.code}: ${issue.reason}`;
    }
  }
  return undefined;
};

/** Who one decision reaches: the roles it edits, the capabilities and cells it grants, the holders it moves. */
export interface ConfigureCheck {
  /** The person deciding: only the manager a delegation belongs to may lean on it. */
  readonly actor: PrincipalId;
  readonly affectedAgentHolder: boolean;
  readonly affectedAssignmentScopeIds: readonly AccessScopeId[];
  readonly affectedHolderPrincipals: readonly PrincipalId[];
  readonly at: Date;
  readonly authority: AccessConfigureBasis;
  readonly capabilityKeys: readonly CapabilityKey[];
  readonly grantedCells: readonly GrantedCell[];
  readonly roles: readonly Role[];
  readonly tenantId: string;
}

/**
 * Configuration authority for one decision: every edited role must be inside the decider's scope,
 * and a delegated manager is additionally bounded by the exact envelope above (P3, P8, D10, O28).
 */
export const configureAuthorityIssue = (check: ConfigureCheck): AccessChangesError | undefined => {
  const uncovered = check.roles.find((role) => !configureBasisCoversRole(check.authority, role));
  if (uncovered !== undefined) {
    return accessChangesError(
      'access_changes_authority_missing',
      `the decider cannot configure role ${uncovered.name}`,
    );
  }
  const managerBasis = Match.value(check.authority).pipe(
    Match.tags({
      DelegatedManager: ({ delegation, scope }) => ({ delegation, scope }),
      Owner: () => null,
      ScopeAdmin: () => null,
    }),
    Match.exhaustive,
  );
  if (managerBasis === null) {
    return undefined;
  }
  const { delegation, scope } = managerBasis;
  if (delegation.managerId !== check.actor) {
    return accessChangesError(
      'access_changes_delegation_out_of_envelope',
      `delegation ${delegation.id} belongs to another manager; a delegation is never borrowed`,
    );
  }
  if (!delegationIsLive(delegation, check.at)) {
    return accessChangesError(
      'access_changes_delegation_out_of_envelope',
      `delegation ${delegation.id} is not live at the time of the decision`,
    );
  }
  if (check.affectedAgentHolder) {
    return accessChangesError(
      'access_changes_delegation_out_of_envelope',
      'a delegation never reaches an agent holder',
    );
  }
  const envelope = delegationEnvelopeIssue({
    affectedAssignmentScopeIds: check.affectedAssignmentScopeIds,
    affectedHolderPrincipals: check.affectedHolderPrincipals,
    at: check.at,
    capabilityKeys: check.capabilityKeys,
    delegation,
    grantedCells: check.grantedCells,
    roles: check.roles,
    scope,
    tenantId: check.tenantId,
  });
  return envelope === undefined ? undefined : accessChangesError('access_changes_delegation_out_of_envelope', envelope);
};
