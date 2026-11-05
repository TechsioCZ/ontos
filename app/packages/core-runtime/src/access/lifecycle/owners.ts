import { Clock, DateTime, Effect, Match, Option, Schema } from 'effect';

import { AccessScopeIdSchema, PrincipalIdSchema } from '../ids.ts';
import type { AccessScopeId, PrincipalId } from '../ids.ts';
import type { AccessLifecycleError } from './errors.ts';
import { lifecycleRefusal } from './errors.ts';

/**
 * One tenant-owner row as the writer projects it. Owner status is management authority, never
 * business access: it survives without a legal-entity selection and grants nothing operational.
 */
export const OwnerRecordSchema = Schema.Struct({
  membershipValidUntil: Schema.optionalKey(Schema.Date),
  principalId: PrincipalIdSchema,
  status: Schema.Literals(['active', 'suspended']),
});
export type OwnerRecord = typeof OwnerRecordSchema.Type;

/**
 * Every mutation route that can end a principal's tenant-owner status. The guard runs on all of
 * them: a new route is added here, and the exhaustive match below forces its successor semantics.
 */
export const OWNER_REMOVAL_ROUTES = [
  'account_deletion',
  'demotion',
  'departure',
  'member_removal',
  'suspension',
  'transfer',
] as const;
export const OwnerRemovalRouteSchema = Schema.Literals(OWNER_REMOVAL_ROUTES);
export type OwnerRemovalRoute = typeof OwnerRemovalRouteSchema.Type;

/** The `company#access_admin` rows of one company, together with the scope they administer. */
export const ScopeAdministratorsSchema = Schema.Struct({
  administrators: Schema.Array(OwnerRecordSchema),
  scopeId: AccessScopeIdSchema,
});
/**
 * Who can administer which scope of one tenant, as Core reads it from the engine (O64: a fact read
 * through a port, never a flag a caller asserts). `tenant#owner` rows administer every scope
 * (`administer = owner & access`); a company adds its own `company#access_admin` rows.
 */
export const ScopeAdministrationSchema = Schema.Struct({
  /** `company#access_admin` rows, one entry per scope that has its own administrators. */
  scopeAdministrators: Schema.Array(ScopeAdministratorsSchema),
  /** The access scope of the tenant itself, so every ownership domain is named by a scope id. */
  tenantScopeId: AccessScopeIdSchema,
  /** `tenant#owner` rows: these people administer the tenant and every scope inside it. */
  tenantOwners: Schema.Array(OwnerRecordSchema),
});
export type ScopeAdministration = typeof ScopeAdministrationSchema.Type;

export interface OwnerRemovalRequest {
  /** Owners created by the same operation; a transfer removes only after its successor exists. */
  readonly adding?: readonly OwnerRecord[];
  readonly owners: readonly OwnerRecord[];
  readonly removing: PrincipalId;
  readonly route: OwnerRemovalRoute;
}

export interface OwnerRemovalOutcome {
  /** Owners that can still administer the tenant once the removal is applied. */
  readonly liveOwnerIds: readonly PrincipalId[];
  /** Earliest end date among them, so a screen can warn before the tenant loses its last owner. */
  readonly nextOwnerEndsAt: Option.Option<Date>;
}

const isLiveOwner = (now: Date, owner: OwnerRecord): boolean =>
  owner.status === 'active' && (owner.membershipValidUntil === undefined || owner.membershipValidUntil > now);

const successorRequirement = (
  route: OwnerRemovalRoute,
  adding: readonly OwnerRecord[],
): Effect.Effect<void, AccessLifecycleError> =>
  Match.value(route).pipe(
    Match.when('transfer', () =>
      adding.length > 0
        ? Effect.void
        : Effect.fail(
            lifecycleRefusal(
              'owner_transfer_without_successor',
              'A transfer of tenant ownership adds the successor in the same operation',
            ),
          ),
    ),
    Match.orElse(() => Effect.void),
  );

const liveOwnersAfter = (
  request: OwnerRemovalRequest,
  adding: readonly OwnerRecord[],
  now: Date,
): readonly OwnerRecord[] =>
  [...request.owners.filter((owner) => owner.principalId !== request.removing), ...adding].filter((owner) =>
    isLiveOwner(now, owner),
  );

const uniquePrincipalIds = (owners: readonly OwnerRecord[]): readonly PrincipalId[] => [
  ...new Set(owners.map((owner) => owner.principalId)),
];

const earliestEnd = (owners: readonly OwnerRecord[]): Option.Option<Date> =>
  Option.fromUndefinedOr(
    owners
      .flatMap((owner) => (owner.membershipValidUntil === undefined ? [] : [owner.membershipValidUntil]))
      .toSorted((left, right) => left.getTime() - right.getTime())[0],
  );

/**
 * D5: the last owner of a tenant is never removed by any route. Suspension counts as removal,
 * because a suspended owner cannot administer; an owner whose membership already ended is not
 * counted either, so a silently unadministered tenant is refused instead of discovered later.
 */
export const guardOwnerRemoval = Effect.fn('accessLifecycle.guardOwnerRemoval')(function* guardOwnerRemovalEffect(
  request: OwnerRemovalRequest,
): Effect.fn.Return<OwnerRemovalOutcome, AccessLifecycleError> {
  const now = DateTime.toDateUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const adding = request.adding ?? [];
  yield* successorRequirement(request.route, adding);
  const liveOwners = liveOwnersAfter(request, adding, now);
  if (liveOwners.length === 0) {
    return yield* lifecycleRefusal(
      'last_owner_removal',
      `The ${request.route} route would leave the tenant without an owner who can administer it`,
    );
  }
  return {
    liveOwnerIds: uniquePrincipalIds(liveOwners),
    nextOwnerEndsAt: earliestEnd(liveOwners),
  };
});

/** Pure preview of the same rule for an editor that must disable the control before saving. */
export const ownerRemovalBlocked = (request: OwnerRemovalRequest, now: Date): boolean =>
  liveOwnersAfter(request, request.adding ?? [], now).length === 0;

/** The people who can administer one scope right now, one entry per person. */
export const liveAdministratorIds = (owners: readonly OwnerRecord[], at: Date): readonly PrincipalId[] => {
  const live = new Set<PrincipalId>();
  for (const owner of owners) {
    if (isLiveOwner(at, owner)) {
      live.add(owner.principalId);
    }
  }
  return [...live];
};

/**
 * The administration rows of one scope: the tenant's owners cover every scope, and a company adds
 * the rows of its own administrators. The tenant's own scope has exactly its owners.
 */
export const administratorsOfScope = (
  administration: ScopeAdministration,
  scopeId: AccessScopeId,
): readonly OwnerRecord[] =>
  scopeId === administration.tenantScopeId
    ? administration.tenantOwners
    : [
        ...administration.tenantOwners,
        ...administration.scopeAdministrators.flatMap((row) => (row.scopeId === scopeId ? row.administrators : [])),
      ];

/**
 * O53: the person is the only one who can administer the scope right now. The fact is derived from
 * the administration rows Core read, so no caller can claim it for itself and skip the transfer.
 */
export const isSoleAdministrator = (request: {
  readonly administration: ScopeAdministration;
  readonly at: Date;
  readonly principalId: PrincipalId;
  readonly scopeId: AccessScopeId;
}): boolean => {
  const live = liveAdministratorIds(administratorsOfScope(request.administration, request.scopeId), request.at);
  return live.length === 1 && live[0] === request.principalId;
};
