import type { AccessDeclaration, OperationalScope } from '@app/core-runtime';
import { declaredAccessCarrier, defineSystemModuleEntrypoint } from '@app/core-runtime';
import { stableUuid } from '@app/core-runtime/access/catalog';
import type { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  DelegationIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
} from '@app/core-runtime/access/ids';
import type { PrincipalId } from '@app/core-runtime/access/ids';
import { AccessMembershipIdSchema } from '@app/core-runtime/access/intent/memberships';
import { AccessPeopleDirectory } from '@app/core-runtime/access/intent/people-directory';
import type {
  AccessDirectoryPerson,
  AccessDirectoryScopeLabels,
} from '@app/core-runtime/access/intent/people-directory';
import { AccessTeamMemberIdSchema } from '@app/core-runtime/access/intent/teams';
import { membershipIsLive, soleAdministrationScopeIds } from '@app/core-runtime/access/lifecycle/people-commands';
import { AccessPeopleCommands } from '@app/core-runtime/access/lifecycle/people-service';
import type { AccessPeopleView, PeopleCommandFailure } from '@app/core-runtime/access/lifecycle/people-service';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer, Option, Predicate, Result, Schema } from 'effect';
import type { Headers as EffectHeaders } from 'effect/http/Headers';

import type {
  AccessAdminProblem,
  AccessPeopleMutationResponse,
  AssignAccessRolePayload,
  CreateAccessDelegationPayload,
  ListAccessAssignmentsPayload,
  ListAccessAssignmentsResponse,
  ListAccessPeopleOptionsResponse,
  ListAccessPeoplePayload,
  ListAccessPeopleResponse,
  RevokeAccessAssignmentPayload,
  RevokeAccessDelegationPayload,
  SetAccessTeamMembershipPayload,
  TransferAccessOwnershipPayload,
} from '../../shared/access-admin-api.ts';
import {
  AccessPeopleMutationResponseSchema,
  ListAccessAssignmentsResponseSchema,
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import { AccessAdminClock } from './clock.ts';
import { coversNoRole, roleReadScope } from './role-read-scope.ts';
import type { RoleReadScope } from './role-read-scope.ts';
import {
  AccessAdminSession,
  accessAdminConflictProblem,
  accessAdminForbiddenProblem,
  accessAdminInternalProblem,
  accessAdminUnavailableProblem,
  accessAdminUnprocessableProblem,
} from './session.ts';
import { AccessPeopleWriteAvailability } from './people-write-gate.ts';

/*
 * "Lidé": who belongs to the tenant, which roles they hold where, the delegations they manage and the
 * teams they sit in, plus the six writes that change it. Core owns every rule (`people-service.ts`):
 * this module admits the request, narrows what it may see, names the identities a write mints from its
 * idempotency key and maps Core's refusals onto the wire.
 *
 * Four rules shape it:
 *
 * 1. **Every operation asks its own capability.** Each read and write has a declared
 *    `shell-super-app.access-people.*` entrypoint, decided by the one gate at a Core instant. Nothing
 *    in a request names a tenant, an actor or an authority.
 * 2. **Tenant admission is not company authority** (O88). The tenant context is asked first, then each
 *    company of the tenant in its own required scope, exactly as the Role editor asks
 *    (`role-read-scope.ts`). A person, an assignment, a delegation, a membership or a team outside the
 *    companies this person's authority covers is withheld before anything is shaped, and a write that
 *    names one is refused exactly like a write that names nothing at all.
 * 3. **The revision is the screen's.** It is a digest of exactly the rows this person may see, so a
 *    change outside their authority neither leaks through it nor makes their form stale; a write whose
 *    echoed revision is not the current one is a 409 the client repairs by re-reading.
 * 4. **Writes ship behind Lidé's own write gate** (`write-gate.ts`), apart from Novinky's: while it is closed,
 *    every write is a retryable 503 and the options report every write as unavailable. Each write's
 *    identities (assignment incarnation, delegation, team place, management memberships) are derived
 *    from its idempotency key, so a retry names the same rows instead of forking new ones.
 */

const MODULE_KEY = 'shell-super-app';

const entrypoint = (key: string, access: 'read' | 'write') =>
  defineSystemModuleEntrypoint({
    access,
    authorization: { kind: 'protected' },
    entrypointKey: `shell-super-app.access-people.${key}`,
    moduleKey: MODULE_KEY,
    role: 'api',
  });

/** One declared entrypoint per operation, each with its own capability (O1, O27, O62). */
export const accessPeopleEntrypoints = Object.freeze({
  assign: entrypoint('assign', 'write'),
  assignments: entrypoint('assignments', 'read'),
  delegate: entrypoint('delegate', 'write'),
  list: entrypoint('list', 'read'),
  options: entrypoint('options', 'read'),
  revokeAssignment: entrypoint('revoke-assignment', 'write'),
  revokeDelegation: entrypoint('revoke-delegation', 'write'),
  teamMembership: entrypoint('team-membership', 'write'),
  transferOwnership: entrypoint('transfer-ownership', 'write'),
});

type PeopleEntrypoint = (typeof accessPeopleEntrypoints)[keyof typeof accessPeopleEntrypoints];

/** Reading who holds what is administrative work; changing it changes who holds authority (O23). */
const peopleDeclaration = (target: PeopleEntrypoint): AccessDeclaration => {
  const write = target.access === 'write';
  const carrier = declaredAccessCarrier({
    accessDeclaration: {
      key: target.entrypointKey,
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'access', level: write ? 'manage' : 'extended' },
      risk: write ? 'critical' : 'sensitive',
      selectors: [],
    },
    entrypoint: target,
  });
  // A carrier the definition-time validation refused is a module-level bug, so the module does not load.
  return Option.getOrThrow(Option.fromUndefinedOr(carrier.accessDeclaration));
};

/** Published with the Shell module's declarations (O50: never a private allow of this file). */
export const accessPeopleDeclarations = Object.freeze({
  assign: peopleDeclaration(accessPeopleEntrypoints.assign),
  assignments: peopleDeclaration(accessPeopleEntrypoints.assignments),
  delegate: peopleDeclaration(accessPeopleEntrypoints.delegate),
  list: peopleDeclaration(accessPeopleEntrypoints.list),
  options: peopleDeclaration(accessPeopleEntrypoints.options),
  revokeAssignment: peopleDeclaration(accessPeopleEntrypoints.revokeAssignment),
  revokeDelegation: peopleDeclaration(accessPeopleEntrypoints.revokeDelegation),
  teamMembership: peopleDeclaration(accessPeopleEntrypoints.teamMembership),
  transferOwnership: peopleDeclaration(accessPeopleEntrypoints.transferOwnership),
});

const forbidden = accessAdminForbiddenProblem;
const conflict = accessAdminConflictProblem;
const unprocessable = accessAdminUnprocessableProblem;

const PEOPLE_NOT_AVAILABLE = 'Lidé is not available to this person.';
const PERSON_NOT_AVAILABLE = 'That person is not available to this tenant.';
const ROLE_NOT_AVAILABLE = 'That role is not available to this tenant.';
const SCOPE_NOT_AVAILABLE = 'That scope is not available to this tenant.';
const ASSIGNMENT_NOT_AVAILABLE = 'That assignment is not available to this tenant.';
const DELEGATION_NOT_AVAILABLE = 'That delegation is not available to this tenant.';
const TEAM_NOT_AVAILABLE = 'That team is not available to this tenant.';

const FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  'delegation_outside_grantor_authority',
  'delegation_redelegation',
  'delegation_self_grant',
  'people_actor_not_a_person',
  'people_authority_missing',
]);
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'access_intent_record_conflict',
  'access_intent_scope_mismatch',
  'access_intent_status_terminated',
  'access_intent_write_refused',
  'delegation_not_live',
  'ownership_transfer_not_required',
  'ownership_transfer_required',
  'people_assignment_already_ended',
  'people_assignment_unknown',
  'people_membership_already_active',
  'people_role_revision_mismatch',
  'people_team_membership_exists',
  'people_team_membership_unknown',
]);

/**
 * Core's refusals, mapped once. An authority Core itself refuses is a denial; a row that moved or a
 * lost compare-and-set is a 409 the client repairs by re-reading; an unreadable store, an unwritten
 * projection or a tenant without its context scope is a retryable 503; every other rule is a 422.
 */
export const accessPeopleFailureProblem = (failure: PeopleCommandFailure): AccessAdminProblem => {
  const text = `${failure.code}: ${failure.reason}`;
  if (FORBIDDEN_CODES.has(failure.code)) {
    return forbidden(text);
  }
  if (CONFLICT_CODES.has(failure.code)) {
    return conflict(text);
  }
  if (
    failure.code === 'access_intent_unavailable' ||
    failure.code === 'people_tenant_scope_missing' ||
    failure.code.startsWith('access_projection_write_')
  ) {
    return accessAdminUnavailableProblem();
  }
  return unprocessable(text);
};

/** An unreadable directory is a retry that keeps Core's own code, never a smaller answer. */
const directoryUnavailable = (failure: { readonly code: string }): AccessAdminProblem => ({
  ...accessAdminUnavailableProblem(),
  detail: `Access administration is temporarily unavailable (${failure.code}). Please retry.`,
});

/** Wire answers are built as plain values and decoded, so the published contract validates each one. */
const encoded = <Value, Input>(schema: Schema.Decoder<Value>, plain: Input, what: string) => {
  const decoded = Schema.decodeUnknownResult(schema)(plain);
  return Result.isFailure(decoded)
    ? Effect.fail(
        accessAdminInternalProblem(
          `The ${what} answer does not match the published contract: ${decoded.failure.message}`,
        ),
      )
    : Effect.succeed(decoded.success);
};

/* ------------------------------------------------------------------------------------------------
 * What one request may see (O88)
 * ---------------------------------------------------------------------------------------------- */

type View = AccessPeopleView;
type ViewAssignment = View['assignments'][number];
type ViewDelegation = View['delegations'][number];
type ViewMembership = View['memberships'][number];
type ViewTeam = View['teams'][number];
type ScopeTarget = { readonly kind: 'tenant' } | { readonly kind: 'company'; readonly legalEntityId: string };

/** The scopes one operation's own declaration admitted: the tenant context, and the companies it named. */
interface PeopleReach {
  readonly readable: RoleReadScope;
  readonly scopeIds: ReadonlySet<string>;
}

const reachOf = (view: View, readable: RoleReadScope): PeopleReach => {
  const scopeIds = new Set<string>();
  for (const row of view.scopes) {
    const visible =
      row.legalEntityId === undefined
        ? row.scopeId === view.tenantScopeId && readable.tenant
        : readable.companies.has(row.legalEntityId);
    if (visible) {
      scopeIds.add(row.scopeId);
    }
  }
  return { readable, scopeIds };
};

const scopeTargetOf = (view: View, scopeId: string): ScopeTarget => {
  const row = view.scopes.find((candidate) => candidate.scopeId === scopeId);
  return row?.legalEntityId === undefined ? { kind: 'tenant' } : { kind: 'company', legalEntityId: row.legalEntityId };
};

/** The access scope a wire target names, when the tenant has one; a company the tenant lacks has none. */
const scopeIdOfTarget = (view: View, target: ScopeTarget): Option.Option<string> =>
  target.kind === 'tenant'
    ? Option.some(view.tenantScopeId)
    : Option.fromUndefinedOr(view.scopes.find((row) => row.legalEntityId === target.legalEntityId)?.scopeId);

const principalOfHolder = (holder: ViewAssignment['holder']): string | undefined =>
  Predicate.isTagged(holder, 'Principal') ? String(holder.principalId) : undefined;

/** A role is readable where it lives: a company's role in its company, a tenant role in the tenant context. */
const roleIsReachable = (reach: PeopleReach, legalEntityId: string | undefined): boolean =>
  legalEntityId === undefined ? reach.readable.tenant : reach.readable.companies.has(legalEntityId);

const visibleMemberships = (view: View, reach: PeopleReach): readonly ViewMembership[] =>
  view.memberships.filter((membership) => reach.scopeIds.has(membership.scopeId));

/** Everyone holding a membership row in a reachable scope; agents never appear on this surface (O67-Q5). */
const visiblePrincipalIds = (view: View, reach: PeopleReach): readonly PrincipalId[] => {
  const ids = new Set<string>();
  for (const membership of visibleMemberships(view, reach)) {
    const principalId = principalOfHolder(membership.holder);
    if (principalId !== undefined) {
      ids.add(principalId);
    }
  }
  return [...ids].map((id) => PrincipalIdSchema.make(id));
};

/**
 * The revision of exactly what this reach shows (rule 3). A row the person cannot see takes no part,
 * so it neither leaks through the token nor makes their form stale.
 */
const revisionOf = (view: View, reach: PeopleReach): string => {
  const lines = [
    ...[...reach.scopeIds].map((scopeId) => `scope ${scopeId}`),
    ...visibleMemberships(view, reach).map(
      (membership) =>
        `membership ${membership.id} ${membership.kind} ${membership.status} ${membership.validFrom.toISOString()}`,
    ),
    ...view.assignments.flatMap((assignment) =>
      reach.scopeIds.has(assignment.scopeId)
        ? [`assignment ${assignment.incarnationId} ${assignment.status} ${assignment.roleRevisionId}`]
        : [],
    ),
    ...view.delegations.flatMap((delegation) =>
      reach.scopeIds.has(delegation.scopeId) ? [`delegation ${delegation.id} ${delegation.status}`] : [],
    ),
    ...view.teams.flatMap((entry) =>
      reach.scopeIds.has(entry.team.scopeId) ? entry.members.map((member) => `team ${entry.team.id} ${member.id}`) : [],
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  return stableUuid(['ontos.shell.access-people.revision', ...lines].join('\n'));
};

/* ------------------------------------------------------------------------------------------------
 * The wire shapes, built as plain values the published schema then decodes
 * ---------------------------------------------------------------------------------------------- */

/** An active row whose period ended is expired on the wire, as the gate already treats it. */
const lifecycleOf = (
  status: 'active' | 'expired' | 'revoked',
  validUntil: Date | undefined,
  at: Date,
): 'active' | 'expired' | 'revoked' =>
  status === 'active' && validUntil !== undefined && validUntil <= at ? 'expired' : status;

const withOptional = <Base extends object, Key extends string, Value>(
  base: Base,
  key: Key,
  value: Value | undefined,
): Base & Partial<Record<Key, Value>> => (value === undefined ? base : { ...base, [key]: value });

const plainCeiling = (ceiling: { readonly currency: string; readonly limitMinor: number } | undefined) =>
  ceiling === undefined ? undefined : { currency: ceiling.currency, limitMinor: ceiling.limitMinor };

const plainAssignment = (view: View, assignment: ViewAssignment, principalId: string) => {
  const role = view.roles.find((entry) => entry.role.id === assignment.roleId);
  const base = {
    incarnationId: assignment.incarnationId,
    principalId,
    roleId: assignment.roleId,
    roleName: role?.role.name ?? assignment.roleId,
    scope: scopeTargetOf(view, assignment.scopeId),
    status: lifecycleOf(assignment.status, assignment.validUntil, view.at),
    validFrom: assignment.validFrom.toISOString(),
    validUntil: assignment.validUntil?.toISOString() ?? null,
  };
  const { delegated } = assignment;
  return delegated === undefined
    ? base
    : {
        ...base,
        delegated: withOptional(
          {
            capabilityKeys: [...delegated.capabilityKeys],
            delegationId: delegated.delegationId,
            until: delegated.until.toISOString(),
          },
          'amountCeiling',
          plainCeiling(delegated.amountCeiling),
        ),
      };
};

const plainDelegation = (view: View, delegation: ViewDelegation) =>
  withOptional(
    {
      capabilityKeys: [...delegation.capabilityKeys],
      delegationId: delegation.id,
      managerId: delegation.managerId,
      people: [...delegation.people],
      roleIds: [...delegation.roleIds],
      scope: scopeTargetOf(view, delegation.scopeId),
      status: lifecycleOf(delegation.status, delegation.validUntil, view.at),
      validFrom: delegation.validFrom.toISOString(),
      validUntil: delegation.validUntil.toISOString(),
    },
    'amountCeiling',
    plainCeiling(delegation.amountCeiling),
  );

const plainMembership = (view: View, membership: ViewMembership) => ({
  kind: membership.kind,
  scope: scopeTargetOf(view, membership.scopeId),
  status: membership.status,
  validFrom: membership.validFrom.toISOString(),
  validUntil: membership.validUntil?.toISOString() ?? null,
});

const plainTeam = (view: View, entry: ViewTeam) => ({
  name: entry.team.name,
  scope: scopeTargetOf(view, entry.team.scopeId),
  teamId: entry.team.id,
});

const holdsMembership = (membership: ViewMembership, principalId: string): boolean =>
  principalOfHolder(membership.holder) === principalId;

/** The scopes this reach shows in which the person administers, and in which they administer alone. */
const ownershipOf = (view: View, reach: PeopleReach, principalId: string) => {
  const administers = new Set<string>();
  for (const membership of view.memberships) {
    if (
      holdsMembership(membership, principalId) &&
      membership.kind !== 'member' &&
      reach.scopeIds.has(membership.scopeId) &&
      membershipIsLive(membership, view.at)
    ) {
      administers.add(membership.scopeId);
    }
  }
  const sole = soleAdministrationScopeIds({
    administration: view.administration,
    at: view.at,
    principalId: PrincipalIdSchema.make(principalId),
  }).filter((scopeId) => reach.scopeIds.has(scopeId));
  return {
    administersScopes: [...administers].map((scopeId) => scopeTargetOf(view, scopeId)),
    soleAdministratorScopes: sole.map((scopeId) => scopeTargetOf(view, scopeId)),
  };
};

const plainPerson = (view: View, reach: PeopleReach, person: AccessDirectoryPerson) => {
  const principalId = String(person.principalId);
  const memberships = visibleMemberships(view, reach).filter((membership) => holdsMembership(membership, principalId));
  return {
    assignments: view.assignments.flatMap((assignment) =>
      reach.scopeIds.has(assignment.scopeId) && principalOfHolder(assignment.holder) === principalId
        ? [plainAssignment(view, assignment, principalId)]
        : [],
    ),
    delegations: view.delegations.flatMap((delegation) =>
      reach.scopeIds.has(delegation.scopeId) && delegation.managerId === principalId
        ? [plainDelegation(view, delegation)]
        : [],
    ),
    displayName: person.displayName,
    memberships: memberships.map((membership) => plainMembership(view, membership)),
    ownership: ownershipOf(view, reach, principalId),
    principalId,
    suspended: person.status !== 'active' || memberships.some((membership) => membership.status === 'suspended'),
    teams: view.teams.flatMap((entry) =>
      reach.scopeIds.has(entry.team.scopeId) &&
      entry.members.some((member) => principalOfHolder(member.holder) === principalId)
        ? [plainTeam(view, entry)]
        : [],
    ),
  };
};

/** One person as a form offers them: where they are a live member, administer alone, may take over. */
const plainChoice = (view: View, reach: PeopleReach, person: AccessDirectoryPerson) => {
  const principalId = String(person.principalId);
  const live = view.memberships.filter(
    (membership) =>
      holdsMembership(membership, principalId) &&
      reach.scopeIds.has(membership.scopeId) &&
      membershipIsLive(membership, view.at),
  );
  const memberOf = new Set<string>();
  const administers = new Set<string>();
  for (const { kind, scopeId } of live) {
    (kind === 'member' ? memberOf : administers).add(scopeId);
  }
  return {
    canTakeOwnershipOfScopes: [...memberOf].flatMap((scopeId) =>
      administers.has(scopeId) ? [] : [scopeTargetOf(view, scopeId)],
    ),
    displayName: person.displayName,
    memberOfScopes: [...memberOf].map((scopeId) => scopeTargetOf(view, scopeId)),
    principalId,
    soleAdministratorScopes: ownershipOf(view, reach, principalId).soleAdministratorScopes,
  };
};

const RISK_ORDER = ['routine', 'sensitive', 'critical'] as const;
type Risk = (typeof RISK_ORDER)[number];
const riskier = (left: Risk, right: Risk): Risk =>
  RISK_ORDER.indexOf(right) > RISK_ORDER.indexOf(left) ? right : left;

/** A role is as risky as its riskiest cell, as the release rates each capability. */
const roleRiskOf = (
  cells: readonly { readonly capabilityKey: string }[],
  riskOf: ReadonlyMap<string, { readonly risk: Risk }>,
): Risk => {
  let highest: Risk = 'routine';
  for (const cell of cells) {
    highest = riskier(highest, riskOf.get(cell.capabilityKey)?.risk ?? 'routine');
  }
  return highest;
};

const pageOf = <Item>(items: readonly Item[], payload: { readonly cursor?: string; readonly limit: number }) => {
  const offset = payload.cursor === undefined ? 0 : Math.trunc(Number(payload.cursor));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return Effect.fail(unprocessable('the cursor of this page is not a known position'));
  }
  const next = offset + payload.limit;
  return Effect.succeed({ items: items.slice(offset, next), nextCursor: next < items.length ? String(next) : null });
};

/* ------------------------------------------------------------------------------------------------
 * The operations
 * ---------------------------------------------------------------------------------------------- */

/** The instant of one administration request, minted at the composition root from the one Clock (D6). */
const coreInstant = AccessAdminClock.pipe(Effect.flatMap(({ now }) => now));

const requireScope = (headers: Headers) =>
  AccessAdminSession.pipe(Effect.flatMap(({ requireTenantContext }) => requireTenantContext(headers)));

const readView = (scope: OperationalScope) =>
  AccessPeopleCommands.pipe(
    Effect.flatMap((commands) => commands.read(scope)),
    Effect.mapError(accessPeopleFailureProblem),
  );

const companiesOf = (view: View): readonly string[] =>
  view.scopes.flatMap(({ legalEntityId }) => (legalEntityId === undefined ? [] : [legalEntityId]));

/** What one operation's own declaration lets this person see, decided before any row is shaped. */
const reachFor = Effect.fn('AccessAdminPeople.reach')(function* reachForDeclaration(
  scope: OperationalScope,
  view: View,
  declaration: AccessDeclaration,
  now: Date,
) {
  const readable = yield* roleReadScope({ companies: companiesOf(view), declaration, now, scope });
  return reachOf(view, readable);
});

/** A read that covers no scope at all is refused, never answered as an empty page. */
const requireReach = Effect.fn('AccessAdminPeople.requireReach')(function* requireReachForDeclaration(
  scope: OperationalScope,
  view: View,
  declaration: AccessDeclaration,
  now: Date,
) {
  const reach = yield* reachFor(scope, view, declaration, now);
  return coversNoRole(reach.readable) ? yield* Effect.fail(forbidden(PEOPLE_NOT_AVAILABLE)) : reach;
});

/** The directory rows of the people this reach shows, in a stable order; agents are not people here. */
const visiblePeople = Effect.fn('AccessAdminPeople.visiblePeople')(function* visiblePeopleOf(
  scope: OperationalScope,
  view: View,
  reach: PeopleReach,
) {
  const directory = yield* AccessPeopleDirectory;
  const rows = yield* directory
    .people(scope, visiblePrincipalIds(view, reach))
    .pipe(Effect.mapError(directoryUnavailable));
  return rows
    .filter(({ kind }) => kind === 'human')
    .toSorted(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.principalId.localeCompare(right.principalId),
    );
});

/** One admitted read: the session, the tenant's people intent and what this declaration may see of it. */
const admitRead = Effect.fn('AccessAdminPeople.admitRead')(function* admitPeopleRead(
  headers: Headers,
  declaration: AccessDeclaration,
) {
  const scope = yield* requireScope(headers);
  const view = yield* readView(scope);
  const now = yield* coreInstant;
  const reach = yield* requireReach(scope, view, declaration, now);
  return { now, reach, scope, view };
});

const scopeLabelOf = (labels: AccessDirectoryScopeLabels, view: View, scopeId: string): string => {
  const target = scopeTargetOf(view, scopeId);
  if (target.kind === 'tenant') {
    return labels.tenantName ?? view.tenantScopeId;
  }
  return (
    labels.companies.find((company) => company.legalEntityId === target.legalEntityId)?.legalName ??
    target.legalEntityId
  );
};

/** Whether this person may run one write anywhere this reach shows, as the gate answers right now. */
const writeAllowed = Effect.fn('AccessAdminPeople.writeAllowed')(function* writeAllowedNow(
  scope: OperationalScope,
  view: View,
  declaration: AccessDeclaration,
  now: Date,
) {
  const gate = yield* AccessPeopleWriteAvailability;
  if (!gate.available) {
    return false;
  }
  const reach = yield* reachFor(scope, view, declaration, now);
  return reach.scopeIds.size > 0;
});

/** The capabilities this person themselves holds live in one of the scopes, which bound a delegation (D10b). */
const heldCapabilityKeys = (view: View, actor: string, scopeIds: ReadonlySet<string>): ReadonlySet<string> => {
  const revisions = new Map(view.roles.map((entry) => [entry.revision.id, entry.revision] as const));
  const held = new Set<string>();
  for (const assignment of view.assignments) {
    const live =
      scopeIds.has(assignment.scopeId) &&
      principalOfHolder(assignment.holder) === actor &&
      lifecycleOf(assignment.status, assignment.validUntil, view.at) === 'active' &&
      assignment.validFrom <= view.at;
    for (const cell of live ? (revisions.get(assignment.roleRevisionId)?.cells ?? []) : []) {
      held.add(cell.capabilityKey);
    }
  }
  return held;
};

const list = Effect.fn('AccessAdminPeople.list')(function* listPeople(
  headers: Headers,
  payload: ListAccessPeoplePayload,
) {
  const { reach, scope, view } = yield* admitRead(headers, accessPeopleDeclarations.list);
  const people = yield* visiblePeople(scope, view, reach);
  const query = payload.query?.toLocaleLowerCase();
  const target = payload.scope;
  const wanted = target === undefined ? Option.none<string>() : scopeIdOfTarget(view, target);
  // The page is cut after the narrowing: a withheld person shifts no cursor and is never counted.
  const matching = people.filter(
    (person) =>
      (query === undefined || person.displayName.toLocaleLowerCase().includes(query)) &&
      (target === undefined ||
        (Option.isSome(wanted) &&
          reach.scopeIds.has(wanted.value) &&
          view.memberships.some(
            (membership) =>
              membership.scopeId === wanted.value && holdsMembership(membership, String(person.principalId)),
          ))),
  );
  const page = yield* pageOf(matching, payload);
  return yield* encoded(
    ListAccessPeopleResponseSchema,
    {
      items: page.items.map((person) => plainPerson(view, reach, person)),
      nextCursor: page.nextCursor,
      revision: revisionOf(view, reach),
    },
    'people list',
  );
});

const options = Effect.fn('AccessAdminPeople.options')(function* listPeopleOptions(
  headers: Headers,
  payload: ListAccessPeoplePayload,
) {
  const { now, reach, scope, view } = yield* admitRead(headers, accessPeopleDeclarations.options);
  const directory = yield* AccessPeopleDirectory;
  const commands = yield* AccessPeopleCommands;
  const [people, labels, catalog] = yield* Effect.all(
    [
      visiblePeople(scope, view, reach),
      directory.scopeLabels(scope).pipe(Effect.mapError(directoryUnavailable)),
      commands.readCatalog(scope).pipe(Effect.mapError(accessPeopleFailureProblem)),
    ],
    { concurrency: 1 },
  );
  // One gate answer per write, so a control shows exactly what the server would admit right now.
  const [canAssign, canUnassign, canManageTeams, canDelegate, canRevokeDelegation, canTransferOwnership] =
    yield* Effect.all(
      [
        writeAllowed(scope, view, accessPeopleDeclarations.assign, now),
        writeAllowed(scope, view, accessPeopleDeclarations.revokeAssignment, now),
        writeAllowed(scope, view, accessPeopleDeclarations.teamMembership, now),
        writeAllowed(scope, view, accessPeopleDeclarations.delegate, now),
        writeAllowed(scope, view, accessPeopleDeclarations.revokeDelegation, now),
        writeAllowed(scope, view, accessPeopleDeclarations.transferOwnership, now),
      ],
      { concurrency: 1 },
    );
  const roles = view.roles.filter(({ role }) => roleIsReachable(reach, role.legalEntityId));
  const entryOf = new Map(catalog.map((entry) => [String(entry.key), entry] as const));
  // A tenant-wide reader is offered the release whole; a company's administrator only the
  // capabilities their readable roles pin, as the Role editor narrows it (O88).
  const pinned = new Set(
    roles.flatMap(({ revision }) => revision.cells.map(({ capabilityKey }) => String(capabilityKey))),
  );
  const offered = reach.readable.tenant ? catalog : catalog.filter(({ key }) => pinned.has(key));
  const requested = payload.scope === undefined ? Option.none<string>() : scopeIdOfTarget(view, payload.scope);
  const grantorScopes = Option.match(requested, {
    onNone: () => reach.scopeIds,
    onSome: (scopeId) => new Set(reach.scopeIds.has(scopeId) ? [scopeId] : []),
  });
  const held = heldCapabilityKeys(view, scope.principalId, grantorScopes);
  const choices = people.map((person) => plainChoice(view, reach, person));
  return yield* encoded(
    ListAccessPeopleOptionsResponseSchema,
    {
      // Stub until lane L2 lists the candidates and computes canAdmitMember and canEndMembership.
      admissionCandidates: [],
      capabilities: offered.map((entry) => ({
        capabilityKey: entry.key,
        hasAmountInput: entry.amountInput !== undefined,
        moduleKey: entry.moduleKey,
        risk: entry.risk,
        withinGrantorAuthority: held.has(entry.key),
      })),
      managers: choices.filter(
        (choice) => choice.principalId !== scope.principalId && choice.memberOfScopes.length > 0,
      ),
      people: choices,
      revision: revisionOf(view, reach),
      roles: roles.map(({ revision, role }) => ({
        capabilityKeys: [...new Set(revision.cells.map(({ capabilityKey }) => capabilityKey))],
        latestRevisionId: revision.id,
        name: role.name,
        risk: roleRiskOf(revision.cells, entryOf),
        roleId: role.id,
        scope:
          role.legalEntityId === undefined
            ? { kind: 'tenant' as const }
            : { kind: 'company' as const, legalEntityId: role.legalEntityId },
      })),
      scopes: [...reach.scopeIds].map((scopeId) => ({
        label: scopeLabelOf(labels, view, scopeId),
        scope: scopeTargetOf(view, scopeId),
      })),
      teams: view.teams.flatMap((entry) => (reach.scopeIds.has(entry.team.scopeId) ? [plainTeam(view, entry)] : [])),
      writeAvailability: {
        canAdmitMember: false,
        canAssign,
        canDelegate,
        canEndMembership: false,
        canManageTeams,
        canRevokeDelegation,
        canTransferOwnership,
        canUnassign,
      },
    },
    'people options',
  );
});

const assignments = Effect.fn('AccessAdminPeople.assignments')(function* listPersonAssignments(
  headers: Headers,
  payload: ListAccessAssignmentsPayload,
) {
  const { reach, scope, view } = yield* admitRead(headers, accessPeopleDeclarations.assignments);
  const people = yield* visiblePeople(scope, view, reach);
  if (!people.some((person) => String(person.principalId) === payload.principalId)) {
    // A person outside this reach is indistinguishable from one that does not exist.
    return yield* Effect.fail(forbidden(PERSON_NOT_AVAILABLE));
  }
  const held = view.assignments.filter(
    (assignment) =>
      reach.scopeIds.has(assignment.scopeId) && principalOfHolder(assignment.holder) === payload.principalId,
  );
  const page = yield* pageOf(held, payload);
  return yield* encoded(
    ListAccessAssignmentsResponseSchema,
    {
      items: page.items.map((assignment) => plainAssignment(view, assignment, payload.principalId)),
      nextCursor: page.nextCursor,
    },
    'person assignments',
  );
});

/** One administration write: the session headers, the decoded payload and its idempotency key. */
export interface AccessPeopleWrite<Payload> {
  readonly headers: Headers;
  readonly idempotencyKey: string;
  readonly payload: Payload;
}

/** The identity one write mints, named by its idempotency key so a retry names the same row. */
const mintedId = (scope: OperationalScope, kind: string, idempotencyKey: string, part = '') =>
  stableUuid([`ontos.shell.access-people.${kind}`, scope.tenantId, idempotencyKey, part].join(':'));

/**
 * The hand-off every write starts with: the session, the ship gate, the screen's revision (read in the
 * list's own reach, so a write never invents staleness the screen could not see) and the write's own
 * reach, decided by its own capability.
 */
const admitWrite = Effect.fn('AccessAdminPeople.admitWrite')(function* admitPeopleWrite(
  headers: Headers,
  declaration: AccessDeclaration,
  expectedRevision: string,
) {
  const scope = yield* requireScope(headers);
  const gate = yield* AccessPeopleWriteAvailability;
  if (!gate.available) {
    // The ship gate is closed: the surface ships the screen, never a partial write.
    return yield* Effect.fail(accessAdminUnavailableProblem());
  }
  const view = yield* readView(scope);
  const now = yield* coreInstant;
  const shown = yield* reachFor(scope, view, accessPeopleDeclarations.list, now);
  const reach = yield* requireReach(scope, view, declaration, now);
  if (revisionOf(view, shown) !== expectedRevision) {
    // A retry of a write that committed but failed to reconcile lands here, because its own commit
    // moved the revision. Converging the projection first means that write still takes effect.
    yield* AccessPeopleCommands.pipe(
      Effect.flatMap((commands) => commands.reconcile(scope)),
      Effect.mapError(accessPeopleFailureProblem),
    );
    return yield* Effect.fail(conflict('the people of this tenant changed since this screen was read; reload Lidé'));
  }
  const people = yield* visiblePeople(scope, view, reach);
  return { people, reach, scope, view };
});

type AdmittedWrite = Effect.Success<ReturnType<typeof admitWrite>>;

const requirePerson = (admitted: AdmittedWrite, principalId: string) =>
  admitted.people.some((person) => String(person.principalId) === principalId)
    ? Effect.void
    : Effect.fail(forbidden(PERSON_NOT_AVAILABLE));

const requireScopeTarget = (admitted: AdmittedWrite, target: ScopeTarget) => {
  const scopeId = scopeIdOfTarget(admitted.view, target);
  return Option.isSome(scopeId) && admitted.reach.scopeIds.has(scopeId.value)
    ? Effect.succeed(AccessScopeIdSchema.make(scopeId.value))
    : Effect.fail(forbidden(SCOPE_NOT_AVAILABLE));
};

/** What one write changed, in the contract's own encoded form; the revision is added by the answer. */
type PeopleChange = Omit<typeof AccessPeopleMutationResponseSchema.Encoded, 'revision'>;

/** The answer every write gives: what changed, and the revision of what this person sees now. */
const mutationAnswer = Effect.fn('AccessAdminPeople.mutationAnswer')(function* mutationAnswerOf(
  admitted: AdmittedWrite,
  changed: PeopleChange,
) {
  const view = yield* readView(admitted.scope);
  const now = yield* coreInstant;
  const shown = yield* reachFor(admitted.scope, view, accessPeopleDeclarations.list, now);
  return yield* encoded(
    AccessPeopleMutationResponseSchema,
    { ...changed, revision: revisionOf(view, shown) },
    'people write',
  );
});

const assign = Effect.fn('AccessAdminPeople.assign')(function* assignRole({
  headers,
  idempotencyKey,
  payload,
}: AccessPeopleWrite<AssignAccessRolePayload>) {
  const admitted = yield* admitWrite(headers, accessPeopleDeclarations.assign, payload.expectedRevision);
  const scopeId = yield* requireScopeTarget(admitted, payload.scope);
  yield* requirePerson(admitted, payload.principalId);
  const role = admitted.view.roles.find((entry) => entry.role.id === payload.roleId);
  if (role === undefined || !roleIsReachable(admitted.reach, role.role.legalEntityId)) {
    return yield* Effect.fail(forbidden(ROLE_NOT_AVAILABLE));
  }
  if (role.revision.id !== payload.expectedRoleRevisionId) {
    return yield* Effect.fail(conflict('the role changed since this screen was read; reload Lidé'));
  }
  const commands = yield* AccessPeopleCommands;
  const command = {
    incarnationId: AssignmentIncarnationIdSchema.make(mintedId(admitted.scope, 'assignment', idempotencyKey)),
    principalId: PrincipalIdSchema.make(payload.principalId),
    roleId: RoleIdSchema.make(payload.roleId),
    roleRevisionId: RoleRevisionIdSchema.make(payload.expectedRoleRevisionId),
    scopeId,
  };
  const receipt = yield* commands
    .assignRole(
      admitted.scope,
      payload.validUntil === undefined ? command : { ...command, validUntil: DateTime.toDateUtc(payload.validUntil) },
    )
    .pipe(Effect.mapError(accessPeopleFailureProblem));
  return yield* mutationAnswer(
    admitted,
    withOptional(
      {},
      'assignment',
      receipt.assignment === undefined
        ? undefined
        : plainAssignment(admitted.view, receipt.assignment, payload.principalId),
    ),
  );
});

const revokeAssignment = Effect.fn('AccessAdminPeople.revokeAssignment')(function* revokeAssignmentWrite({
  headers,
  payload,
}: AccessPeopleWrite<RevokeAccessAssignmentPayload>) {
  const admitted = yield* admitWrite(headers, accessPeopleDeclarations.revokeAssignment, payload.expectedRevision);
  const assignment = admitted.view.assignments.find((candidate) => candidate.incarnationId === payload.incarnationId);
  const principalId = assignment === undefined ? undefined : principalOfHolder(assignment.holder);
  if (assignment === undefined || principalId === undefined || !admitted.reach.scopeIds.has(assignment.scopeId)) {
    return yield* Effect.fail(forbidden(ASSIGNMENT_NOT_AVAILABLE));
  }
  const commands = yield* AccessPeopleCommands;
  const receipt = yield* commands
    .unassignRole(admitted.scope, { incarnationId: assignment.incarnationId })
    .pipe(Effect.mapError(accessPeopleFailureProblem));
  return yield* mutationAnswer(
    admitted,
    withOptional(
      {},
      'assignment',
      receipt.assignment === undefined ? undefined : plainAssignment(admitted.view, receipt.assignment, principalId),
    ),
  );
});

const setTeamMembership = Effect.fn('AccessAdminPeople.setTeamMembership')(function* setTeamMembershipWrite({
  headers,
  idempotencyKey,
  payload,
}: AccessPeopleWrite<SetAccessTeamMembershipPayload>) {
  const admitted = yield* admitWrite(headers, accessPeopleDeclarations.teamMembership, payload.expectedRevision);
  const team = admitted.view.teams.find((entry) => entry.team.id === payload.teamId);
  if (team === undefined || !admitted.reach.scopeIds.has(team.team.scopeId)) {
    return yield* Effect.fail(forbidden(TEAM_NOT_AVAILABLE));
  }
  yield* requirePerson(admitted, payload.principalId);
  const commands = yield* AccessPeopleCommands;
  yield* commands
    .setTeamMembership(admitted.scope, {
      action: payload.action,
      memberId: AccessTeamMemberIdSchema.make(mintedId(admitted.scope, 'team-member', idempotencyKey)),
      principalId: PrincipalIdSchema.make(payload.principalId),
      teamId: payload.teamId,
    })
    .pipe(Effect.mapError(accessPeopleFailureProblem));
  return yield* mutationAnswer(admitted, {
    teamMembership: { active: payload.action === 'join', principalId: payload.principalId, teamId: payload.teamId },
  });
});

const createDelegation = Effect.fn('AccessAdminPeople.createDelegation')(function* createDelegationWrite({
  headers,
  idempotencyKey,
  payload,
}: AccessPeopleWrite<CreateAccessDelegationPayload>) {
  const admitted = yield* admitWrite(headers, accessPeopleDeclarations.delegate, payload.expectedRevision);
  const scopeId = yield* requireScopeTarget(admitted, payload.scope);
  yield* Effect.forEach([payload.managerId, ...payload.people], (principalId) => requirePerson(admitted, principalId), {
    concurrency: 1,
    discard: true,
  });
  const roles = new Map(admitted.view.roles.map((entry) => [String(entry.role.id), entry] as const));
  const unreachable = payload.roleIds.some((roleId) => {
    const role = roles.get(roleId);
    return role === undefined || !roleIsReachable(admitted.reach, role.role.legalEntityId);
  });
  if (unreachable) {
    return yield* Effect.fail(forbidden(ROLE_NOT_AVAILABLE));
  }
  const commands = yield* AccessPeopleCommands;
  const command = {
    capabilityKeys: payload.capabilityKeys.map((key) => CapabilityKeySchema.make(key)),
    delegationId: DelegationIdSchema.make(mintedId(admitted.scope, 'delegation', idempotencyKey)),
    managerId: PrincipalIdSchema.make(payload.managerId),
    people: payload.people.map((principalId) => PrincipalIdSchema.make(principalId)),
    roleIds: payload.roleIds.map((roleId) => RoleIdSchema.make(roleId)),
    scopeId,
    validUntil: DateTime.toDateUtc(payload.validUntil),
  };
  const receipt = yield* commands
    .grantDelegation(
      admitted.scope,
      payload.amountCeiling === undefined ? command : { ...command, amountCeiling: payload.amountCeiling },
    )
    .pipe(Effect.mapError(accessPeopleFailureProblem));
  return yield* mutationAnswer(
    admitted,
    withOptional(
      {},
      'delegation',
      receipt.delegation === undefined
        ? undefined
        : { delegationId: receipt.delegation.id, status: receipt.delegation.status },
    ),
  );
});

const revokeDelegation = Effect.fn('AccessAdminPeople.revokeDelegation')(function* revokeDelegationWrite({
  headers,
  payload,
}: AccessPeopleWrite<RevokeAccessDelegationPayload>) {
  const admitted = yield* admitWrite(headers, accessPeopleDeclarations.revokeDelegation, payload.expectedRevision);
  const delegation = admitted.view.delegations.find((candidate) => candidate.id === payload.delegationId);
  if (delegation === undefined || !admitted.reach.scopeIds.has(delegation.scopeId)) {
    return yield* Effect.fail(forbidden(DELEGATION_NOT_AVAILABLE));
  }
  const commands = yield* AccessPeopleCommands;
  yield* commands
    .revokeDelegation(admitted.scope, { delegationId: delegation.id })
    .pipe(Effect.mapError(accessPeopleFailureProblem));
  return yield* mutationAnswer(admitted, { delegation: { delegationId: delegation.id, status: 'revoked' } });
});

const transferOwnership = Effect.fn('AccessAdminPeople.transferOwnership')(function* transferOwnershipWrite({
  headers,
  idempotencyKey,
  payload,
}: AccessPeopleWrite<TransferAccessOwnershipPayload>) {
  const admitted = yield* admitWrite(headers, accessPeopleDeclarations.transferOwnership, payload.expectedRevision);
  yield* requirePerson(admitted, payload.fromPrincipalId);
  yield* requirePerson(admitted, payload.toPrincipalId);
  const scopeIds = yield* Effect.forEach(payload.scopes, (target) => requireScopeTarget(admitted, target), {
    concurrency: 1,
  });
  const commands = yield* AccessPeopleCommands;
  yield* commands
    .transferOwnership(admitted.scope, {
      fromPrincipalId: PrincipalIdSchema.make(payload.fromPrincipalId),
      membershipIds: scopeIds.map((scopeId) =>
        AccessMembershipIdSchema.make(mintedId(admitted.scope, 'ownership', idempotencyKey, scopeId)),
      ),
      scopeIds,
      toPrincipalId: PrincipalIdSchema.make(payload.toPrincipalId),
    })
    .pipe(Effect.mapError(accessPeopleFailureProblem));
  return yield* mutationAnswer(admitted, { transferredScopes: [...payload.scopes] });
});

const accessPeopleOperations = {
  assign,
  assignments,
  createDelegation,
  list,
  options,
  revokeAssignment,
  revokeDelegation,
  setTeamMembership,
  transferOwnership,
};

/** The requirements of one operation, taken from the operation itself. */
type OperationRequirements<Operation> = Operation extends (
  ...parameters: never[]
) => Effect.Effect<unknown, unknown, infer Requirements>
  ? Requirements
  : never;

/** Every port "Lidé" reads and writes, taken from the operations so none is restated by hand. */
export type AccessPeopleRequirements = OperationRequirements<
  (typeof accessPeopleOperations)[keyof typeof accessPeopleOperations]
>;

export interface AccessPeopleBffService {
  readonly assign: (
    input: AccessPeopleWrite<AssignAccessRolePayload>,
  ) => Effect.Effect<AccessPeopleMutationResponse, AccessAdminProblem>;
  readonly assignments: (
    headers: Headers,
    payload: ListAccessAssignmentsPayload,
  ) => Effect.Effect<ListAccessAssignmentsResponse, AccessAdminProblem>;
  readonly createDelegation: (
    input: AccessPeopleWrite<CreateAccessDelegationPayload>,
  ) => Effect.Effect<AccessPeopleMutationResponse, AccessAdminProblem>;
  readonly list: (
    headers: Headers,
    payload: ListAccessPeoplePayload,
  ) => Effect.Effect<ListAccessPeopleResponse, AccessAdminProblem>;
  readonly options: (
    headers: Headers,
    payload: ListAccessPeoplePayload,
  ) => Effect.Effect<ListAccessPeopleOptionsResponse, AccessAdminProblem>;
  readonly revokeAssignment: (
    input: AccessPeopleWrite<RevokeAccessAssignmentPayload>,
  ) => Effect.Effect<AccessPeopleMutationResponse, AccessAdminProblem>;
  readonly revokeDelegation: (
    input: AccessPeopleWrite<RevokeAccessDelegationPayload>,
  ) => Effect.Effect<AccessPeopleMutationResponse, AccessAdminProblem>;
  readonly setTeamMembership: (
    input: AccessPeopleWrite<SetAccessTeamMembershipPayload>,
  ) => Effect.Effect<AccessPeopleMutationResponse, AccessAdminProblem>;
  readonly transferOwnership: (
    input: AccessPeopleWrite<TransferAccessOwnershipPayload>,
  ) => Effect.Effect<AccessPeopleMutationResponse, AccessAdminProblem>;
}

export class AccessPeopleBff extends Context.Service<AccessPeopleBff, AccessPeopleBffService>()(
  '@app/shell-super-app/api/access-admin/people/AccessPeopleBff',
) {}

/** "Lidé" of this process: the composition provides its ports once (O66). */
export const AccessPeopleBffLive: Layer.Layer<AccessPeopleBff, never, AccessPeopleRequirements | AccessDecisionGate> =
  Layer.effect(
    AccessPeopleBff,
    Effect.gen(function* accessPeopleBffLayer() {
      const context = yield* Effect.context<AccessPeopleRequirements | AccessDecisionGate>();
      const operations = yield* Effect.succeed(accessPeopleOperations);
      return {
        assign: (input) => operations.assign(input).pipe(Effect.provideContext(context)),
        assignments: (headers, payload) =>
          operations.assignments(headers, payload).pipe(Effect.provideContext(context)),
        createDelegation: (input) => operations.createDelegation(input).pipe(Effect.provideContext(context)),
        list: (headers, payload) => operations.list(headers, payload).pipe(Effect.provideContext(context)),
        options: (headers, payload) => operations.options(headers, payload).pipe(Effect.provideContext(context)),
        revokeAssignment: (input) => operations.revokeAssignment(input).pipe(Effect.provideContext(context)),
        revokeDelegation: (input) => operations.revokeDelegation(input).pipe(Effect.provideContext(context)),
        setTeamMembership: (input) => operations.setTeamMembership(input).pipe(Effect.provideContext(context)),
        transferOwnership: (input) => operations.transferOwnership(input).pipe(Effect.provideContext(context)),
      };
    }),
  );

/** The handler's headers as the web `Headers` a session port reads, from the runtime's own domain type. */
const asHeaders = (input: EffectHeaders): Headers => new Headers(Object.entries(input));

export const accessAdminPeopleGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'accessAdminPeople',
  (handlers) =>
    handlers
      .handle('listAccessPeople', ({ payload, request }) =>
        AccessPeopleBff.pipe(Effect.flatMap((bff) => bff.list(asHeaders(request.headers), payload))),
      )
      .handle('listAccessPeopleOptions', ({ payload, request }) =>
        AccessPeopleBff.pipe(Effect.flatMap((bff) => bff.options(asHeaders(request.headers), payload))),
      )
      .handle('listAccessAssignments', ({ payload, request }) =>
        AccessPeopleBff.pipe(Effect.flatMap((bff) => bff.assignments(asHeaders(request.headers), payload))),
      )
      .handle('assignAccessRole', ({ headers, payload, request }) =>
        AccessPeopleBff.pipe(
          Effect.flatMap((bff) =>
            bff.assign({ headers: asHeaders(request.headers), idempotencyKey: headers['idempotency-key'], payload }),
          ),
        ),
      )
      .handle('revokeAccessAssignment', ({ headers, payload, request }) =>
        AccessPeopleBff.pipe(
          Effect.flatMap((bff) =>
            bff.revokeAssignment({
              headers: asHeaders(request.headers),
              idempotencyKey: headers['idempotency-key'],
              payload,
            }),
          ),
        ),
      )
      .handle('setAccessTeamMembership', ({ headers, payload, request }) =>
        AccessPeopleBff.pipe(
          Effect.flatMap((bff) =>
            bff.setTeamMembership({
              headers: asHeaders(request.headers),
              idempotencyKey: headers['idempotency-key'],
              payload,
            }),
          ),
        ),
      )
      .handle('createAccessDelegation', ({ headers, payload, request }) =>
        AccessPeopleBff.pipe(
          Effect.flatMap((bff) =>
            bff.createDelegation({
              headers: asHeaders(request.headers),
              idempotencyKey: headers['idempotency-key'],
              payload,
            }),
          ),
        ),
      )
      .handle('revokeAccessDelegation', ({ headers, payload, request }) =>
        AccessPeopleBff.pipe(
          Effect.flatMap((bff) =>
            bff.revokeDelegation({
              headers: asHeaders(request.headers),
              idempotencyKey: headers['idempotency-key'],
              payload,
            }),
          ),
        ),
      )
      .handle('transferAccessOwnership', ({ headers, payload, request }) =>
        AccessPeopleBff.pipe(
          Effect.flatMap((bff) =>
            bff.transferOwnership({
              headers: asHeaders(request.headers),
              idempotencyKey: headers['idempotency-key'],
              payload,
            }),
          ),
        ),
      )
      // Stub until lane L2 implements admission: a retryable 503, so nothing is written by accident.
      .handle('admitAccessMember', () => Effect.fail(accessAdminUnavailableProblem()))
      // Stub until lane L2 implements ending: a retryable 503, so nothing is written by accident.
      .handle('endAccessMembership', () => Effect.fail(accessAdminUnavailableProblem())),
);
