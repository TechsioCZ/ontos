import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import { accessMemberships } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { AccessScopeIdSchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type { Holder } from '../model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, HolderSchema } from '../model.ts';
import type { AccessIntentError } from './errors.ts';
import { intentConflict } from './errors.ts';
import type { AccessIntentDatabase } from './persistence.ts';
import {
  actorIssue,
  asDate,
  decodeStored,
  durable,
  holderColumns,
  principalIdOf,
  optionalProperty,
  runScoped,
  scopeIssue,
} from './persistence.ts';

/*
 * Membership is the first half of every decision: a capability, an installation and a grant all
 * resolve inside a scope, and `scope->access` is built from membership (guarantee 3, D6). PostgreSQL
 * holds it as intent — one row per holder, scope and kind — so a deadline, a suspension and a
 * departure are all facts Core reads instead of a projection that might trail behind.
 *
 * `member` is operational membership and is the only kind an agent can hold. `owner` (the tenant
 * context) and `access_admin` (one company) are management authority: `administer` still requires
 * membership first (O28), which is why a person has one row per kind rather than one merged row.
 */

export const AccessMembershipIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AccessMembershipId'));
export type AccessMembershipId = typeof AccessMembershipIdSchema.Type;

/** What a membership is: operational participation, or management authority on top of it. */
export const MEMBERSHIP_KINDS = ['member', 'owner', 'access_admin'] as const;
export const MembershipKindSchema = Schema.Literals(MEMBERSHIP_KINDS);
export type MembershipKind = typeof MembershipKindSchema.Type;

export const MEMBERSHIP_STATUSES = ['active', 'suspended', 'revoked'] as const;
export const MembershipStatusSchema = Schema.Literals(MEMBERSHIP_STATUSES);
export type MembershipStatus = typeof MembershipStatusSchema.Type;

/**
 * A membership only ever ends. Suspension is reversible and leaves the holder a member the graph
 * subtracts; a revoked membership is final, so a rejoin is a new row and never a revived one (D27).
 */
const MEMBERSHIP_STATUS_TRANSITIONS = {
  active: ['suspended', 'revoked'],
  revoked: [],
  suspended: ['active', 'revoked'],
} as const satisfies Readonly<Record<MembershipStatus, readonly MembershipStatus[]>>;

export const canTransitionMembershipStatus = (from: MembershipStatus, to: MembershipStatus): boolean =>
  MEMBERSHIP_STATUS_TRANSITIONS[from].some((next: MembershipStatus) => next === to);

const membershipPeriod = Schema.makeFilter<{ readonly validFrom: Date; readonly validUntil?: Date }>(
  ({ validFrom, validUntil }) =>
    validUntil === undefined || validFrom < validUntil || 'validUntil must follow validFrom',
);
/** Management authority is a verified human's own relation, never an agent's (O46). */
const managerIsAPerson = Schema.makeFilter<{ readonly holder: Holder; readonly kind: MembershipKind }>(
  ({ holder, kind }) =>
    kind === 'member' || Option.isSome(principalIdOf(holder)) || 'Only a person holds management authority',
);

/**
 * One holder's intent in one scope. `validUntil` is the membership deadline Core enforces itself
 * (D6); it is immutable like every other identity column, so extending access is a fresh membership
 * rather than a widening of a row something already relied on.
 */
export const AccessMembershipSchema = Schema.Struct({
  createdAt: Schema.Date,
  holder: HolderSchema,
  id: AccessMembershipIdSchema,
  kind: MembershipKindSchema,
  recordedBy: PrincipalIdSchema,
  scopeId: AccessScopeIdSchema,
  status: MembershipStatusSchema,
  tenantId: TenantIdSchema,
  validFrom: Schema.Date,
  validUntil: Schema.optionalKey(Schema.Date),
}).check(membershipPeriod, managerIsAPerson);
export type AccessMembership = typeof AccessMembershipSchema.Type;

/**
 * The columns every write and read of this store touches, named once, so a column added to the table
 * later cannot silently join a model a caller decodes. The loader reads memberships in its own
 * complete-tenant transaction, so it shares them.
 */
export const membershipColumns = {
  agentId: accessMemberships.agentId,
  createdAt: accessMemberships.createdAt,
  kind: accessMemberships.kind,
  membershipId: accessMemberships.membershipId,
  principalId: accessMemberships.principalId,
  recordedBy: accessMemberships.recordedBy,
  scopeId: accessMemberships.scopeId,
  status: accessMemberships.status,
  tenantId: accessMemberships.tenantId,
  validFrom: accessMemberships.validFrom,
  validUntil: accessMemberships.validUntil,
} as const;

export interface MembershipRow {
  readonly agentId: string | null;
  readonly createdAt: Date | string;
  readonly kind: string;
  readonly membershipId: string;
  readonly principalId: string | null;
  readonly recordedBy: string;
  readonly scopeId: string;
  readonly status: string;
  readonly tenantId: string;
  readonly validFrom: Date | string;
  readonly validUntil: Date | string | null;
}

const decodeMembership = Schema.decodeUnknownResult(AccessMembershipSchema, ACCESS_MODEL_PARSE_OPTIONS);

/** The holder a row really belongs to; SQL keeps exactly one of a person and an agent. */
export const decodeMembershipRow = (row: MembershipRow) =>
  decodeStored(
    decodeMembership({
      createdAt: asDate(row.createdAt),
      holder:
        row.principalId === null
          ? { _tag: 'Agent', agentId: row.agentId }
          : { _tag: 'Principal', principalId: row.principalId },
      id: row.membershipId,
      kind: row.kind,
      recordedBy: row.recordedBy,
      scopeId: row.scopeId,
      status: row.status,
      tenantId: row.tenantId,
      validFrom: asDate(row.validFrom),
      ...optionalProperty({}, 'validUntil', row.validUntil === null ? null : asDate(row.validUntil)),
    }),
    `membership ${row.membershipId}`,
  );

/** The unique indexes of `access_memberships`; a collision is the same conflict as a lost compare-and-set. */
const OWNER_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_memberships_agent_uk',
  'access_memberships_pkey',
  'access_memberships_subject_uk',
  'access_memberships_tenant_id_uk',
]);

export interface RecordMembershipInput {
  readonly membership: AccessMembership;
}

export interface RecordMembershipsInput {
  /** A tenant bootstrap writes the owner and every member in one statement, never one by one. */
  readonly memberships: readonly AccessMembership[];
}

export interface SetMembershipStatusInput {
  readonly membershipId: AccessMembershipId;
  readonly status: MembershipStatus;
}

/**
 * The membership port. Every call names the trusted request scope it runs in, so the tenant and the
 * acting person are the request's and never the command body's (O66).
 */
export interface AccessMembershipStoreService {
  /** Every membership of the tenant, whatever its status: the loader builds each scope from them. */
  readonly loadTenantMemberships: (
    scope: OperationalScope,
  ) => Effect.Effect<readonly AccessMembership[], AccessIntentError>;
  readonly recordMembership: (
    scope: OperationalScope,
    input: RecordMembershipInput,
  ) => Effect.Effect<void, AccessIntentError>;
  readonly recordMemberships: (
    scope: OperationalScope,
    input: RecordMembershipsInput,
  ) => Effect.Effect<void, AccessIntentError>;
  /** Suspends, resumes or ends one membership; the database refuses anything but a forward move. */
  readonly setMembershipStatus: (
    scope: OperationalScope,
    input: SetMembershipStatusInput,
  ) => Effect.Effect<AccessMembership, AccessIntentError>;
}

const insertValues = (membership: AccessMembership) => ({
  ...holderColumns(membership.holder),
  createdAt: membership.createdAt,
  kind: membership.kind,
  membershipId: membership.id,
  recordedBy: membership.recordedBy,
  scopeId: membership.scopeId,
  status: membership.status,
  tenantId: membership.tenantId,
  validFrom: membership.validFrom,
  validUntil: membership.validUntil ?? null,
});

/**
 * The canonical insert inside a transaction Core already owns and has scoped. Verified identity
 * acceptance uses this same writer without manufacturing an OperationalScope or opening another
 * connection; its caller proves attribution and plans the memberships before entering this seam.
 */
export const writeAccessMembershipsFromTransaction = (
  transaction: Pick<CoreTransaction, 'insert'>,
  memberships: readonly AccessMembership[],
): Effect.Effect<void, AccessIntentError> =>
  memberships.length === 0
    ? Effect.void
    : transaction
        .insert(accessMemberships)
        .values(memberships.map(insertValues))
        .pipe(durable(OWNER_UNIQUE_CONSTRAINTS), Effect.asVoid);

interface MembershipCommandIssue {
  readonly code: 'access_intent_record_conflict' | 'access_intent_scope_mismatch';
  readonly reason: string;
}

const commandIssue = (
  scope: OperationalScope,
  memberships: readonly AccessMembership[],
): MembershipCommandIssue | null => {
  for (const membership of memberships) {
    const issue = scopeIssue(scope, [membership.tenantId]) ?? actorIssue(scope, membership.recordedBy);
    if (issue !== null) {
      return { code: 'access_intent_scope_mismatch', reason: issue };
    }
    // A membership is written as it begins: every other state is a transition `setMembershipStatus` owns.
    if (membership.status !== 'active') {
      return {
        code: 'access_intent_record_conflict',
        reason: `membership ${membership.id} is recorded as ${membership.status}; a new membership is active`,
      };
    }
  }
  return null;
};

export const makeAccessMembershipDrizzleStore = (database: AccessIntentDatabase): AccessMembershipStoreService => {
  const loadTenantMemberships: AccessMembershipStoreService['loadTenantMemberships'] = Effect.fn(
    'AccessMembershipStore.loadTenantMemberships',
  )(function* loadTenantMembershipsEffect(scope: OperationalScope) {
    const rows = yield* runScoped(database, scope, OWNER_UNIQUE_CONSTRAINTS, (transaction) =>
      transaction
        .select(membershipColumns)
        .from(accessMemberships)
        .where(eq(accessMemberships.tenantId, scope.tenantId)),
    );
    return yield* Effect.forEach(rows, (row) => decodeMembershipRow(row), { concurrency: 1 });
  });

  const write = (
    scope: OperationalScope,
    memberships: readonly AccessMembership[],
  ): Effect.Effect<void, AccessIntentError> => {
    const issue = commandIssue(scope, memberships);
    return issue === null
      ? runScoped(database, scope, OWNER_UNIQUE_CONSTRAINTS, (transaction) =>
          writeAccessMembershipsFromTransaction(transaction, memberships),
        )
      : Effect.fail(intentConflict(issue.code, issue.reason));
  };

  const recordMembership: AccessMembershipStoreService['recordMembership'] = Effect.fn(
    'AccessMembershipStore.recordMembership',
  )(function* recordMembershipEffect(scope: OperationalScope, { membership }: RecordMembershipInput) {
    return yield* write(scope, [membership]);
  });

  const recordMemberships: AccessMembershipStoreService['recordMemberships'] = Effect.fn(
    'AccessMembershipStore.recordMemberships',
  )(function* recordMembershipsEffect(scope: OperationalScope, { memberships }: RecordMembershipsInput) {
    return yield* write(scope, memberships);
  });

  /** The one transition the store settles itself: a status moves forward and never back. */
  const updateMembershipStatus = Effect.fn('AccessMembershipStore.updateMembershipStatus')(
    function* updateMembershipStatusEffect(
      transaction: CoreTransaction,
      scope: OperationalScope,
      { membershipId, status }: SetMembershipStatusInput,
    ) {
      const [stored] = yield* transaction
        .select(membershipColumns)
        .from(accessMemberships)
        .where(and(eq(accessMemberships.tenantId, scope.tenantId), eq(accessMemberships.membershipId, membershipId)));
      if (stored === undefined) {
        return yield* intentConflict(
          'access_intent_record_conflict',
          `membership ${membershipId} does not exist in this tenant`,
        );
      }
      const current = yield* decodeMembershipRow(stored);
      if (current.status === status) {
        return current;
      }
      if (!canTransitionMembershipStatus(current.status, status)) {
        return yield* intentConflict(
          'access_intent_status_terminated',
          `membership ${membershipId} is ${current.status} and never becomes ${status}`,
        );
      }
      const [updated] = yield* transaction
        .update(accessMemberships)
        .set({ status })
        .where(
          and(
            eq(accessMemberships.tenantId, scope.tenantId),
            eq(accessMemberships.membershipId, membershipId),
            eq(accessMemberships.status, current.status),
          ),
        )
        .returning(membershipColumns);
      // The compare-and-set lost: another writer moved the same membership first, so this
      // command was planned from a state that is no longer the stored one.
      return updated === undefined
        ? yield* intentConflict(
            'access_intent_record_conflict',
            `membership ${membershipId} moved while this command was being written`,
          )
        : yield* decodeMembershipRow(updated);
    },
  );

  const setMembershipStatus: AccessMembershipStoreService['setMembershipStatus'] = Effect.fn(
    'AccessMembershipStore.setMembershipStatus',
  )(function* setMembershipStatusEffect(scope: OperationalScope, command: SetMembershipStatusInput) {
    return yield* runScoped(database, scope, OWNER_UNIQUE_CONSTRAINTS, (transaction) =>
      updateMembershipStatus(transaction, scope, command),
    );
  });

  return Object.freeze({
    loadTenantMemberships,
    recordMembership,
    recordMemberships,
    setMembershipStatus,
  });
};

export class AccessMembershipStore extends Context.Service<AccessMembershipStore, AccessMembershipStoreService>()(
  '@app/core-runtime/access/intent/memberships/AccessMembershipStore',
) {}

export const AccessMembershipStoreLive = Layer.effect(
  AccessMembershipStore,
  Effect.gen(function* accessMembershipStoreLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAccessMembershipDrizzleStore({ enrollment, executor: database.executor });
  }),
);
