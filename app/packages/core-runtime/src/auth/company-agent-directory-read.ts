import { v1 } from '@authzed/authzed-node';
import { and, eq, inArray, or } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { ConfigureAgentAuditEvidenceSchema } from '../modules/actions/configure-agent.action.ts';
import {
  readLatestAgentOperatorCommand,
  ReplaceAgentOperatorsAuditEvidenceSchema,
} from '../modules/actions/agent-operator-command.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { fullyConsistent } from '../permissions/client.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { toLegalEntityAccessObjectId } from '../permissions/context-access.ts';
import { openSpiceDbRpc } from '../permissions/spicedb-transaction-guard.ts';
import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';
import type { ReadFinishContext, ReadLoadContext, ReadPrepareContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';
import {
  AgentProfileProjectionSchema,
  agentProfilesFromTransaction,
  DEFAULT_AGENT_PROFILE,
} from './agent-profile-projection.ts';

const PrincipalIdSchema = ConfigureAgentAuditEvidenceSchema.fields.targetPrincipalId;
export const AgentOperatorCommandSchema = Schema.Struct({
  desiredOperatorPrincipalIds: ReplaceAgentOperatorsAuditEvidenceSchema.fields.desiredOperatorPrincipalIds,
  revision: ReplaceAgentOperatorsAuditEvidenceSchema.fields.revision,
});
export const CompanyAgentDirectoryInputSchema = Schema.Struct({});
export const CompanyAgentDirectoryResultSchema = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      ...AgentProfileProjectionSchema.fields,
      displayName: Schema.String,
      // oxlint-disable-next-line effect-native/no-nullable-schema-field -- Null means no native operator command has been committed, not an empty desired set.
      operatorCommand: Schema.NullOr(AgentOperatorCommandSchema),
      operatorPrincipalIds: Schema.Array(PrincipalIdSchema),
      principalId: PrincipalIdSchema,
      status: Schema.Literals(['active', 'archived', 'disabled']),
    }),
  ),
  members: Schema.Array(PrincipalIdSchema),
  people: Schema.Array(Schema.Struct({ displayName: Schema.String, principalId: PrincipalIdSchema })),
});

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'The company agent directory is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );
const openDirectoryRpc = Effect.acquireRelease(
  loadSpiceDbConfig().pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((configuration) =>
      Effect.try({ catch: unavailable, try: () => openSpiceDbRpc(configuration, 5000) }),
    ),
  ),
  (rpc) => Effect.sync(() => rpc.close()),
);

/** Exact graph relationships, never SQL membership or permission lookup expansion. */
const relatedPrincipalIds = Effect.fn('CompanyAgentDirectory.relatedPrincipalIds')(function* relatedPrincipalIds(
  rpc: SpiceDbRpc,
  resourceType: 'legal_entity' | 'principal',
  resourceId: string,
  relation: 'member' | 'operator',
) {
  const responses = yield* rpc
    .readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: {
          optionalRelation: relation,
          optionalResourceId: resourceId,
          optionalSubjectFilter: { subjectType: 'principal' },
          resourceType,
        },
      }),
    )
    .pipe(Effect.mapError(unavailable));
  return yield* Effect.forEach(
    responses,
    ({ relationship: edge }) => {
      if (
        edge?.resource?.objectType !== resourceType ||
        edge.resource.objectId !== resourceId ||
        edge.relation !== relation ||
        edge.subject?.object?.objectType !== 'principal' ||
        edge.subject.optionalRelation !== ''
      ) {
        return Effect.fail(unavailable('Unexpected directory relationship'));
      }
      return Schema.decodeEffect(PrincipalIdSchema)(edge.subject.object.objectId).pipe(Effect.mapError(unavailable));
    },
    { concurrency: 1 },
  );
});

const prepare = Effect.fn('CompanyAgentDirectory.prepare')(function* prepare(
  _input: typeof CompanyAgentDirectoryInputSchema.Type,
  context: ReadPrepareContext,
) {
  const { legalEntityId, tenantId } = context.scope;
  const companyObjectId =
    legalEntityId === undefined ? undefined : toLegalEntityAccessObjectId(tenantId, legalEntityId);
  if (companyObjectId === undefined) {
    return yield* unavailable('An exact company context is required');
  }
  return yield* Effect.scoped(
    openDirectoryRpc.pipe(Effect.flatMap((rpc) => relatedPrincipalIds(rpc, 'legal_entity', companyObjectId, 'member'))),
  );
});

const agentStatus = (status: string): 'active' | 'archived' | 'disabled' => {
  if (status === 'active' || status === 'archived') {
    return status;
  }
  return 'disabled';
};

const directoryFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('CompanyAgentDirectory.load')(function* load(memberIds: readonly string[]) {
    if (memberIds.length === 0) {
      return { agents: [], people: [] };
    }
    const { tenantId } = transaction.scope;
    const rows = yield* transaction
      .select({
        displayName: principals.displayName,
        kind: principals.kind,
        principalId: principals.principalId,
        status: principals.status,
      })
      .from(principals)
      .where(
        and(
          eq(principals.tenantId, tenantId),
          inArray(principals.principalId, [...memberIds]),
          or(eq(principals.kind, 'agent'), and(eq(principals.kind, 'human'), eq(principals.status, 'active'))),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const agentRows = rows.filter((row) => row.kind === 'agent');
    const agentIds = agentRows.map((row) => row.principalId);
    const profiles = yield* agentProfilesFromTransaction(transaction).load(agentIds);
    // Share the Action/projection's native, principal-global command authority and corruption checks.
    const commandEntries = yield* Effect.forEach(
      agentIds,
      (agentPrincipalId) =>
        readLatestAgentOperatorCommand(transaction, tenantId, agentPrincipalId).pipe(
          Effect.map(
            (command) =>
              [
                agentPrincipalId,
                command === null
                  ? null
                  : {
                      desiredOperatorPrincipalIds: command.desiredOperatorPrincipalIds,
                      revision: command.revision,
                    },
              ] as const,
          ),
          Effect.mapError(unavailable),
        ),
      { concurrency: 1 },
    );
    const commands = new Map(commandEntries);
    const agents = agentRows
      .map((row) => ({
        ...(profiles.get(row.principalId) ?? DEFAULT_AGENT_PROFILE),
        displayName: row.displayName,
        operatorCommand: commands.get(row.principalId) ?? null,
        principalId: row.principalId,
        status: agentStatus(row.status),
      }))
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'cs'));
    const people = rows
      .flatMap((row) => (row.kind === 'human' ? [{ displayName: row.displayName, principalId: row.principalId }] : []))
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'cs'));
    return { agents, people };
  }),
});
type Services = ReturnType<typeof directoryFromTransaction>;
type Loaded = Effect.Success<ReturnType<Services['load']>>;
const load = (
  _input: typeof CompanyAgentDirectoryInputSchema.Type,
  context: ReadLoadContext<Services, readonly string[]>,
) => context.services.load(context.prepared);
const finish = Effect.fn('CompanyAgentDirectory.finish')(function* finish(
  _input: typeof CompanyAgentDirectoryInputSchema.Type,
  context: ReadFinishContext<readonly string[], Loaded>,
) {
  const agents =
    context.loaded.agents.length === 0
      ? []
      : yield* Effect.scoped(
          Effect.gen(function* operatorsOutsideSql() {
            const rpc = yield* openDirectoryRpc;
            return yield* Effect.forEach(
              context.loaded.agents,
              (agent) =>
                relatedPrincipalIds(rpc, 'principal', agent.principalId, 'operator').pipe(
                  Effect.map((operatorPrincipalIds) => ({ ...agent, operatorPrincipalIds })),
                ),
              { concurrency: 4 },
            );
          }),
        );
  const result = yield* Schema.decodeEffect(CompanyAgentDirectoryResultSchema)({
    agents,
    members: context.prepared,
    people: context.loaded.people,
  }).pipe(Effect.mapError(unavailable));
  return { evidence: { resultCount: result.agents.length + result.people.length }, result };
});

export const companyAgentDirectoryRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.company-agent-directory',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.company-agent-directory.access.v1' },
    inputSchema: CompanyAgentDirectoryInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.company-agent-directory',
    resultSchema: CompanyAgentDirectoryResultSchema,
    schemaVersion: '1',
  },
  { finish, load, prepare },
  (transaction) => Effect.succeed(directoryFromTransaction(transaction)),
  () => ({
    kind: 'any_of',
    targets: [
      { kind: 'tenant', permission: 'read_people' },
      { kind: 'legal_entity', permission: 'read_people' },
    ],
  }),
);
