import { and, eq, or } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { principalCompanyMemberships, principals } from '../db/schema.ts';
import { requireAgentAdministration } from './agent-administration.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { ConfigureAgentAuditEvidenceSchema } from '../modules/actions/configure-agent.action.ts';
import {
  readLatestAgentOperatorCommand,
  ReplaceAgentOperatorsAuditEvidenceSchema,
} from '../modules/actions/agent-operator-command.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
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
const prepare = Effect.fn('CompanyAgentDirectory.prepare')(function* prepare(
  _input: typeof CompanyAgentDirectoryInputSchema.Type,
  context: ReadPrepareContext,
) {
  // The directory behind the Agents administration page: only the company's agent administrators read it.
  yield* requireAgentAdministration(context.scope);
  const { legalEntityId } = context.scope;
  if (legalEntityId === undefined) {
    return yield* unavailable('An exact company context is required');
  }
  return legalEntityId;
});

const agentStatus = (status: string): 'active' | 'archived' | 'disabled' => {
  if (status === 'active' || status === 'archived') {
    return status;
  }
  return 'disabled';
};

const directoryFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('CompanyAgentDirectory.load')(function* load(legalEntityId: string) {
    const { tenantId } = transaction.scope;
    // The company's members are its active Core company memberships, the rows the People directory reads; never a
    // SpiceDB relation (a v2 tenant has no legacy `legal_entity#member` tuples, so they would read as nobody).
    const rows = yield* transaction
      .select({
        displayName: principals.displayName,
        kind: principals.kind,
        principalId: principals.principalId,
        status: principals.status,
      })
      .from(principalCompanyMemberships)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, principalCompanyMemberships.tenantId),
          eq(principals.principalId, principalCompanyMemberships.principalId),
        ),
      )
      .where(
        and(
          eq(principalCompanyMemberships.tenantId, tenantId),
          eq(principalCompanyMemberships.legalEntityId, legalEntityId),
          eq(principalCompanyMemberships.status, 'active'),
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
    const people = rows
      .flatMap((row) => (row.kind === 'human' ? [{ displayName: row.displayName, principalId: row.principalId }] : []))
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'cs'));
    const activePeople = new Set(people.map((person) => person.principalId));
    const agents = agentRows
      .map((row) => {
        const operatorCommand = commands.get(row.principalId) ?? null;
        return {
          ...(profiles.get(row.principalId) ?? DEFAULT_AGENT_PROFILE),
          displayName: row.displayName,
          operatorCommand,
          // The operators are the latest committed operator command's people who are still active in the company: the
          // v2 schema projects no operator relation, so the committed command is the only record of them.
          operatorPrincipalIds: (operatorCommand?.desiredOperatorPrincipalIds ?? []).filter((id) =>
            activePeople.has(id),
          ),
          principalId: row.principalId,
          status: agentStatus(row.status),
        };
      })
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'cs'));
    return { agents, members: rows.map((row) => row.principalId), people };
  }),
});
type Services = ReturnType<typeof directoryFromTransaction>;
type Loaded = Effect.Success<ReturnType<Services['load']>>;
const load = (_input: typeof CompanyAgentDirectoryInputSchema.Type, context: ReadLoadContext<Services, string>) =>
  context.services.load(context.prepared);
const finish = Effect.fn('CompanyAgentDirectory.finish')(function* finish(
  _input: typeof CompanyAgentDirectoryInputSchema.Type,
  context: ReadFinishContext<string, Loaded>,
) {
  const result = yield* Schema.decodeEffect(CompanyAgentDirectoryResultSchema)(context.loaded).pipe(
    Effect.mapError(unavailable),
  );
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
    permissionTarget: 'legal_entity',
    policies: [],
    readKey: 'core.identity.company-agent-directory',
    resultSchema: CompanyAgentDirectoryResultSchema,
    schemaVersion: '1',
  },
  { finish, load, prepare },
  (transaction) => Effect.succeed(directoryFromTransaction(transaction)),
  // Admitted by authentication in the gate-decided company scope; `prepare` asks the read's own v2 question. No legacy
  // relation is asked: `read_people` is not v2 intent and the v2 schema defines none, so asking it was unavailable.
  () => ({ kind: 'legal_entity' }),
);
