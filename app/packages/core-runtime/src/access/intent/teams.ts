import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import { accessTeamMembers, accessTeams } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { AccessScopeIdSchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import { AccessTeamIdSchema } from '../decision/authority.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, HolderSchema } from '../model.ts';
import type { AccessIntentError } from './errors.ts';
import { intentConflict } from './errors.ts';
import type { AccessIntentDatabase } from './persistence.ts';
import { actorIssue, asDate, decodeStored, durable, holderColumns, runScoped, scopeIssue } from './persistence.ts';

/*
 * A team is the record scope the `team` selector reads (O24): authority reaches the records of one
 * scope whose team the holder takes part in, and it never reaches outside that scope. Both tables are
 * current intent rather than evidence — a team membership ends and the tuple ends with it — so only
 * the team identity itself is append-only (the migration refuses an update of anything but its name
 * and every delete), while a membership row is added and removed.
 */

export const AccessTeamMemberIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AccessTeamMemberId'));
export type AccessTeamMemberId = typeof AccessTeamMemberIdSchema.Type;

const teamName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** One team of one access scope; the name is the only mutable part of its identity. */
export const AccessTeamSchema = Schema.Struct({
  createdAt: Schema.Date,
  createdBy: PrincipalIdSchema,
  id: AccessTeamIdSchema,
  name: teamName,
  scopeId: AccessScopeIdSchema,
  tenantId: TenantIdSchema,
});
export type AccessTeam = typeof AccessTeamSchema.Type;

/** One holder's place in one team. A holder is a person or an agent, never both (O46). */
export const AccessTeamMemberSchema = Schema.Struct({
  addedAt: Schema.Date,
  addedBy: PrincipalIdSchema,
  holder: HolderSchema,
  id: AccessTeamMemberIdSchema,
  teamId: AccessTeamIdSchema,
  tenantId: TenantIdSchema,
});
export type AccessTeamMember = typeof AccessTeamMemberSchema.Type;

/** A team together with every holder it reaches; what the projection reads and the store serves. */
export interface AccessTeamWithMembers {
  readonly members: readonly AccessTeamMember[];
  readonly team: AccessTeam;
}

const teamColumns = {
  createdAt: accessTeams.createdAt,
  createdBy: accessTeams.createdBy,
  name: accessTeams.name,
  scopeId: accessTeams.scopeId,
  teamId: accessTeams.teamId,
  tenantId: accessTeams.tenantId,
} as const;
const memberColumns = {
  addedAt: accessTeamMembers.addedAt,
  addedBy: accessTeamMembers.addedBy,
  agentId: accessTeamMembers.agentId,
  principalId: accessTeamMembers.principalId,
  teamId: accessTeamMembers.teamId,
  teamMemberId: accessTeamMembers.teamMemberId,
  tenantId: accessTeamMembers.tenantId,
} as const;

interface TeamRow {
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly name: string;
  readonly scopeId: string;
  readonly teamId: string;
  readonly tenantId: string;
}

interface TeamMemberRow {
  readonly addedAt: Date | string;
  readonly addedBy: string;
  readonly agentId: string | null;
  readonly principalId: string | null;
  readonly teamId: string;
  readonly teamMemberId: string;
  readonly tenantId: string;
}

const decodeTeam = Schema.decodeUnknownResult(AccessTeamSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeTeamMember = Schema.decodeUnknownResult(AccessTeamMemberSchema, ACCESS_MODEL_PARSE_OPTIONS);

const teamOf = (row: TeamRow) =>
  decodeStored(
    decodeTeam({
      createdAt: asDate(row.createdAt),
      createdBy: row.createdBy,
      id: row.teamId,
      name: row.name,
      scopeId: row.scopeId,
      tenantId: row.tenantId,
    }),
    `team ${row.teamId}`,
  );

/** The holder a row really belongs to; SQL keeps exactly one of a person and an agent. */
const teamMemberOf = (row: TeamMemberRow) =>
  decodeStored(
    decodeTeamMember({
      addedAt: asDate(row.addedAt),
      addedBy: row.addedBy,
      holder:
        row.principalId === null
          ? { _tag: 'Agent', agentId: row.agentId }
          : { _tag: 'Principal', principalId: row.principalId },
      id: row.teamMemberId,
      teamId: row.teamId,
      tenantId: row.tenantId,
    }),
    `team member ${row.teamMemberId}`,
  );

const TEAM_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_team_members_agent_uk',
  'access_team_members_pkey',
  'access_team_members_principal_uk',
  'access_team_members_tenant_id_uk',
  'access_teams_name_uk',
  'access_teams_pkey',
  'access_teams_tenant_id_uk',
]);

export interface RecordTeamInput {
  readonly team: AccessTeam;
}

export interface RecordTeamMemberInput {
  readonly member: AccessTeamMember;
}

export interface RemoveTeamMemberInput {
  readonly teamMemberId: AccessTeamMemberId;
}

/**
 * The team port. Every call names the trusted request scope it runs in, so the tenant and the acting
 * person are the request's and never the command body's (O66).
 */
export interface AccessTeamStoreService {
  /** Every team of the tenant with the holders it reaches: the projection and the scope reads share it. */
  readonly loadTenantTeams: (
    scope: OperationalScope,
  ) => Effect.Effect<readonly AccessTeamWithMembers[], AccessIntentError>;
  readonly recordTeam: (scope: OperationalScope, input: RecordTeamInput) => Effect.Effect<void, AccessIntentError>;
  readonly recordTeamMember: (
    scope: OperationalScope,
    input: RecordTeamMemberInput,
  ) => Effect.Effect<void, AccessIntentError>;
  /** A holder leaving a team ends the authority the team carried for them; nothing else changes. */
  readonly removeTeamMember: (
    scope: OperationalScope,
    input: RemoveTeamMemberInput,
  ) => Effect.Effect<void, AccessIntentError>;
}

const writeTeam = (transaction: CoreTransaction, team: AccessTeam): Effect.Effect<void, AccessIntentError> =>
  transaction
    .insert(accessTeams)
    .values({
      createdAt: team.createdAt,
      createdBy: team.createdBy,
      name: team.name,
      scopeId: team.scopeId,
      teamId: team.id,
      tenantId: team.tenantId,
    })
    .pipe(durable(TEAM_UNIQUE_CONSTRAINTS), Effect.asVoid);

const writeTeamMember = (
  transaction: CoreTransaction,
  member: AccessTeamMember,
): Effect.Effect<void, AccessIntentError> =>
  transaction
    .insert(accessTeamMembers)
    .values({
      ...holderColumns(member.holder),
      addedAt: member.addedAt,
      addedBy: member.addedBy,
      teamId: member.teamId,
      teamMemberId: member.id,
      tenantId: member.tenantId,
    })
    .pipe(durable(TEAM_UNIQUE_CONSTRAINTS), Effect.asVoid);

/** A team and its membership are one scope's intent; the person is the request's own (O66). */
const teamIssue = (scope: OperationalScope, team: AccessTeam): string | null =>
  scopeIssue(scope, [team.tenantId]) ?? actorIssue(scope, team.createdBy);

const memberIssue = (scope: OperationalScope, member: AccessTeamMember): string | null =>
  scopeIssue(scope, [member.tenantId]) ?? actorIssue(scope, member.addedBy);

export const makeAccessTeamDrizzleStore = (database: AccessIntentDatabase): AccessTeamStoreService => {
  const loadTenantTeams: AccessTeamStoreService['loadTenantTeams'] = Effect.fn('AccessTeamStore.loadTenantTeams')(
    function* loadTenantTeamsEffect(scope: OperationalScope) {
      // One transaction, so a team list and its memberships are the same instant of intent.
      const [teams, members] = yield* runScoped(database, scope, TEAM_UNIQUE_CONSTRAINTS, (transaction) =>
        Effect.all(
          [
            transaction.select(teamColumns).from(accessTeams).where(eq(accessTeams.tenantId, scope.tenantId)),
            transaction
              .select(memberColumns)
              .from(accessTeamMembers)
              .where(eq(accessTeamMembers.tenantId, scope.tenantId)),
          ],
          { concurrency: 1 },
        ),
      );
      const loadedMembers = yield* Effect.forEach(members, (row) => teamMemberOf(row), { concurrency: 1 });
      const loadedTeams = yield* Effect.forEach(teams, (row) => teamOf(row), { concurrency: 1 });
      const membersOfTeam = new Map<string, AccessTeamMember[]>();
      for (const member of loadedMembers) {
        const held = membersOfTeam.get(member.teamId) ?? [];
        held.push(member);
        membersOfTeam.set(member.teamId, held);
      }
      return loadedTeams.map((team): AccessTeamWithMembers => ({ members: membersOfTeam.get(team.id) ?? [], team }));
    },
  );

  const recordTeam: AccessTeamStoreService['recordTeam'] = Effect.fn('AccessTeamStore.recordTeam')(
    function* recordTeamEffect(scope: OperationalScope, { team }: RecordTeamInput) {
      const issue = teamIssue(scope, team);
      return issue === null
        ? yield* runScoped(database, scope, TEAM_UNIQUE_CONSTRAINTS, (transaction) => writeTeam(transaction, team))
        : yield* intentConflict('access_intent_scope_mismatch', issue);
    },
  );

  const recordTeamMember: AccessTeamStoreService['recordTeamMember'] = Effect.fn('AccessTeamStore.recordTeamMember')(
    function* recordTeamMemberEffect(scope: OperationalScope, { member }: RecordTeamMemberInput) {
      const issue = memberIssue(scope, member);
      return issue === null
        ? yield* runScoped(database, scope, TEAM_UNIQUE_CONSTRAINTS, (transaction) =>
            writeTeamMember(transaction, member),
          )
        : yield* intentConflict('access_intent_scope_mismatch', issue);
    },
  );

  const removeTeamMember: AccessTeamStoreService['removeTeamMember'] = Effect.fn('AccessTeamStore.removeTeamMember')(
    function* removeTeamMemberEffect(scope: OperationalScope, { teamMemberId }: RemoveTeamMemberInput) {
      return yield* runScoped(database, scope, TEAM_UNIQUE_CONSTRAINTS, (transaction) =>
        transaction
          .delete(accessTeamMembers)
          .where(and(eq(accessTeamMembers.tenantId, scope.tenantId), eq(accessTeamMembers.teamMemberId, teamMemberId)))
          .returning({ teamMemberId: accessTeamMembers.teamMemberId }),
      );
    },
  );
  return Object.freeze({
    loadTenantTeams,
    recordTeam,
    recordTeamMember,
    removeTeamMember,
  });
};

export class AccessTeamStore extends Context.Service<AccessTeamStore, AccessTeamStoreService>()(
  '@app/core-runtime/access/intent/teams/AccessTeamStore',
) {}

/** The team store over the process's Core pool; every call still names its request scope (O66). */
export const AccessTeamStoreLive: Layer.Layer<
  AccessTeamStore,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessTeamStore,
  Effect.gen(function* accessTeamStoreLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAccessTeamDrizzleStore({ enrollment, executor: database.executor });
  }),
);
