import type { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessEnforcementPortsLive } from '../../src/actions/runtime-wiring.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { compileFullAccessRole } from '../../src/access/bootstrap/full-access-role.ts';
import { legalEntityScopeId, tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { toSortedCells } from '../../src/access/changes/cells.ts';
import { writeRoleCreation, writeRoleRevision } from '../../src/access/changes/role-revision.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import type { AccessProjectionTransport } from '../../src/access/compiler/spice-db-compiler.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import type { AccessCheckItem } from '../../src/access/decision/engine.ts';
import { SPICEDB_V2_SUBJECT_TYPES } from '../../src/access/decision/spicedb-check-port.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import {
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { LegalEntityId, PrincipalId, RoleId, RoleRevisionId, TenantId } from '../../src/access/ids.ts';
import type { CatalogSnapshot, Cell } from '../../src/access/model.ts';
import {
  agentConnectionIdOfGrant,
  AgentConnectionStore,
  AgentConnectionStoreLive,
} from '../../src/access/intent/agent-connections.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipIdSchema, AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessPeopleDirectoryLive } from '../../src/access/intent/people-directory.ts';
import { AccessPeopleStore, AccessPeopleStoreLive } from '../../src/access/intent/people-store.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { AccessTeamStore, makeAccessTeamDrizzleStore } from '../../src/access/intent/teams.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { consentCeilingOf } from '../../src/access/lifecycle/agent-authority.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { AccessPeopleCommands, AccessPeopleCommandsLive } from '../../src/access/lifecycle/people-service.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { replaceAgentOperatorsActionKey } from '../../src/modules/actions/agent-operator-command.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { outboxProducerModuleKey, outboxTopic } from '../../src/outbox/core-identity-principal-lifecycle-changed-v1.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * An agent on authorization v2, end to end on the real stores, the real projection and the real gate over the shared
 * SpiceDB, which carries the whole of `ONTOS_SPICEDB_SCHEMA`. Every question the gate puts to the engine and every
 * relationship the projection reads or writes is recorded, and none may name an object type outside the v2 half of
 * that schema, so nothing in an agent's path can lean on a legacy definition (stage keeps the pruned legacy
 * definitions but never a legacy tuple). The schema itself is never rewritten here: on a shared engine other suites'
 * legacy relationships exist, and deleting their definitions is refused:
 * the owner admits the agent to the company and assigns it a role through the People commands, the operator opens
 * the agent's credential-bound connection, and the gate decides each request AS the agent on that connection. Every
 * revocation path that Core owns is asked again on the next decision.
 */
const V2_MARKER = '// Authorization v2 engine';
/** The definitions of the v2 half of the one schema: the only object types an agent's path may name. */
const V2_DEFINITIONS: ReadonlySet<string> = new Set(
  [
    ...ONTOS_SPICEDB_SCHEMA.slice(ONTOS_SPICEDB_SCHEMA.indexOf(V2_MARKER)).matchAll(/^definition (?<name>[a-z_]+)/gmu),
  ].flatMap((match) => match.groups?.['name'] ?? []),
);

/** Every SpiceDB object type a scenario's gate and projection named, and how many SpiceDB calls they made. */
interface NamedTypes {
  /** One entry per SpiceDB call: which port made it. */
  readonly calls: ('check' | 'read' | 'write')[];
  readonly types: Set<string>;
}

const noteTypes = (named: NamedTypes, call: NamedTypes['calls'][number], types: readonly (string | undefined)[]) =>
  Effect.sync(() => {
    named.calls.push(call);
    for (const type of types) {
      if (type !== undefined && type !== '') {
        named.types.add(type);
      }
    }
  });

/**
 * The real engine port, recording the SpiceDB object types of every item the gate asks it: the resource type as sent, and
 * the subject type through the very map the check transport sends it with (the engine's `principal` is `access_human`).
 */
const recordingDecisionCheck = (named: NamedTypes) =>
  Layer.effect(
    DecisionCheck,
    Effect.gen(function* recordingDecisionCheckEffect() {
      const engine = yield* DecisionCheck;
      return {
        checkBulk: (items: readonly AccessCheckItem[]) =>
          noteTypes(
            named,
            'check',
            items.flatMap((item) => [item.resource.type, SPICEDB_V2_SUBJECT_TYPES[item.subject.type]]),
          ).pipe(Effect.andThen(engine.checkBulk(items))),
      };
    }),
  );

/** The real projection transport, recording the object types of every relationship it reads or writes. */
const recordingProjectionTransport = (
  named: NamedTypes,
  transport: AccessProjectionTransport,
): AccessProjectionTransport => ({
  close: transport.close,
  readRelationships: (request: v1.ReadRelationshipsRequest) =>
    noteTypes(named, 'read', [
      request.relationshipFilter?.resourceType,
      request.relationshipFilter?.optionalSubjectFilter?.subjectType,
    ]).pipe(Effect.andThen(transport.readRelationships(request))),
  writeRelationships: (request: v1.WriteRelationshipsRequest) =>
    noteTypes(
      named,
      'write',
      request.updates.flatMap((update) => [
        update.relationship?.resource?.objectType,
        update.relationship?.subject?.object?.objectType,
      ]),
    ).pipe(Effect.andThen(transport.writeRelationships(request))),
});

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'desk.tasks';
const TASK_READ = 'desk.tasks.task.read';
const TASK_CREATE = 'desk.tasks.task.create';
const TASK_DELETE = 'desk.tasks.task.delete';

const entrypoint = (key: string, access: 'read' | 'write') =>
  defineTenantModuleEntrypoint({
    access,
    authorization: { kind: 'protected' },
    entrypointKey: key,
    moduleKey: MODULE,
    role: access === 'read' ? 'api' : 'action',
  });
const taskRead: AccessDeclarationInput = {
  key: TASK_READ,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'desk', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const taskCreate: AccessDeclarationInput = {
  key: TASK_CREATE,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'desk', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const taskDelete: AccessDeclarationInput = {
  key: TASK_DELETE,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'desk', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
};
const readEntrypoint = entrypoint('desk.tasks.api.task-read', 'read');
const createEntrypoint = entrypoint('desk.tasks.task-create', 'write');
const deleteEntrypoint = entrypoint('desk.tasks.task-delete', 'write');
const modules: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: taskRead, entrypoint: readEntrypoint },
      { accessDeclaration: taskCreate, entrypoint: createEntrypoint },
      { accessDeclaration: taskDelete, entrypoint: deleteEntrypoint },
    ],
    moduleId: MODULE,
  },
];
const readCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(taskRead, readEntrypoint) };
const createCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(taskCreate, createEntrypoint) };
const deleteCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(taskDelete, deleteEntrypoint) };

const owner = PrincipalIdSchema.make(uid(2));
const operator = PrincipalIdSchema.make(uid(3));
const bystander = PrincipalIdSchema.make(uid(4));
const agent = AgentIdSchema.make(uid(5));
const company = LegalEntityIdSchema.make(uid(6));
const otherCompany = LegalEntityIdSchema.make(uid(7));

const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId) =>
  Effect.forEach(
    [
      insertTenantStatement(tenantId),
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values
         ('${company}', '${tenantId}', 'Kancelář s.r.o.', 'CZ', '12345678', 'active'),
         ('${otherCompany}', '${tenantId}', 'Sklad s.r.o.', 'CZ', '87654321', 'active')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${tenantId}', '${owner}', 'human', 'Vlastník', 'active'),
         ('${tenantId}', '${operator}', 'human', 'Operátorka', 'active'),
         ('${tenantId}', '${bystander}', 'human', 'Kolega', 'active'),
         ('${tenantId}', '${agent}', 'agent', 'Agent úkolů', 'active')`,
      `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
         values ('${tenantId}', '${company}', '${agent}', null, 'active'),
                ('${tenantId}', '${company}', '${operator}', 'employee', 'active')`,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
         ('${uid(8)}', '${tenantId}', '${MODULE}', 'active')`,
    ],
    (statement) => admin.unsafe(statement).pipe(Effect.orDie),
    { concurrency: 1, discard: true },
  );

/** The operator and the bystander are members of the tenant and the company, as the People page admits them. */
const seedMembers = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by) values
         ('${uid(20)}', '${tenantId}', '${tenantContextScopeId(tenantId)}', '${operator}', 'member', 'active',
          now() - interval '1 day', '${owner}'),
         ('${uid(21)}', '${tenantId}', '${legalEntityScopeId(tenantId, company)}', '${operator}', 'member', 'active',
          now() - interval '1 day', '${owner}'),
         ('${uid(22)}', '${tenantId}', '${tenantContextScopeId(tenantId)}', '${bystander}', 'member', 'active',
          now() - interval '1 day', '${owner}'),
         ('${uid(23)}', '${tenantId}', '${legalEntityScopeId(tenantId, company)}', '${bystander}', 'member', 'active',
          now() - interval '1 day', '${owner}')`,
    )
    .pipe(Effect.orDie);

/**
 * The agent's operators exactly as the committed `core.identity.replace-agent-operators` Action leaves them: its
 * invocation, its lifecycle event and its sensitive audit evidence at the next revision.
 */
const seedOperators = (admin: PgClient.PgClient, tenantId: TenantId, operators: readonly string[], revision: number) =>
  Effect.gen(function* seedOperatorCommand() {
    const invocation = uid(400 + revision);
    const operatorList = [...operators]
      .toSorted()
      .map((id) => `'${id}'`)
      .join(', ');
    // The committed evidence, built by PostgreSQL itself.
    const evidence = `jsonb_build_object(
      'actionKey', '${replaceAgentOperatorsActionKey}', 'agentPrincipalId', '${agent}', 'context', 'operators-edited',
      'desiredOperatorPrincipalIds', jsonb_build_array(${operatorList}), 'legalEntityId', '${company}',
      'previousRevision', ${revision - 1}, 'revision', ${revision}, 'revokedConnections', 0)`;
    for (const statement of [
      `insert into core.action_invocations (action_invocation_id, tenant_id, legal_entity_id, action_key, status, request_hash)
         values ('${invocation}', '${tenantId}', '${company}', '${replaceAgentOperatorsActionKey}', 'succeeded', 'h${revision}')`,
      `insert into core.domain_events (tenant_id, legal_entity_id, action_invocation_id, producer_module_key, event_type,
         subject_module_key, subject_resource_type, subject_resource_id, payload_json) values
         ('${tenantId}', '${company}', '${invocation}', '${outboxProducerModuleKey}', '${outboxTopic}',
          '${outboxProducerModuleKey}', 'principal', '${agent}',
          jsonb_build_object('data', jsonb_build_object('principalId', '${agent}')))`,
      `insert into core.audit_events (tenant_id, legal_entity_id, action_invocation_id, auth_method, event_type, outcome,
         outcome_stage, outcome_code, audit_profile, evidence_json) values
         ('${tenantId}', '${company}', '${invocation}', 'session', 'action.executed', 'succeeded', 'execution',
          'succeeded', 'sensitive', ${evidence})`,
    ]) {
      yield* admin.unsafe(statement).pipe(Effect.orDie);
    }
  });

const sessionScope = (tenantId: TenantId, principalId: PrincipalId, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: uid(300),
    authContextRef: 'session:access-agent-authority:1',
    authMethod: 'session',
    principalId,
    tenantId,
  };
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-agent-authority' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

/** The trusted scope of an MCP request of the agent's OAuth connection, as the MCP transport builds it. */
const agentScope = (
  tenantId: TenantId,
  grantId: string,
  connection: { readonly connectionId: string; readonly revision: number },
  legalEntityId: LegalEntityId = company,
) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: uid(301),
    authContextRef: `oauth-grant:${grantId}`,
    authMethod: 'oauth_connection',
    connection: {
      agentConnection: connection,
      clientId: 'https://client.example/oauth/metadata.json',
      clientName: 'Client',
      grantId,
      modules: 'all',
      writePolicy: 'direct',
    },
    delegatedByPrincipalId: operator,
    legalEntityId,
    principalId: agent,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-agent-authority:mcp' }) satisfies OperationalScope),
    Effect.orDie,
  );

interface Tenant {
  readonly admin: PgClient.PgClient;
  readonly cellsOf: (capabilityKeys: readonly string[]) => readonly Cell[];
  readonly connections: (typeof AgentConnectionStore)['Service'];
  readonly createRole: (
    capabilityKeys: readonly string[],
    keep?: (cell: Cell) => boolean,
  ) => Effect.Effect<{
    readonly roleId: RoleId;
    readonly roleRevisionId: RoleRevisionId;
  }>;
  /** Records the role's next revision through the role editor's writer: from the cells `before` to `after`. */
  readonly editRole: (
    role: { readonly roleId: RoleId; readonly roleRevisionId: RoleRevisionId },
    before: readonly Cell[],
    after: readonly Cell[],
  ) => Effect.Effect<Option.Option<{ readonly code: string; readonly reason: string }>>;
  readonly gate: (typeof AccessDecisionGate)['Service'];
  readonly newId: Effect.Effect<string>;
  readonly owner: OperationalScope;
  readonly people: (typeof AccessPeopleCommands)['Service'];
  readonly release: CatalogSnapshot;
  readonly tenantId: TenantId;
}

const without = (kept: readonly Cell[], gone: readonly Cell[]) => kept.filter((cell) => !gone.includes(cell));

const withTenant = <Value, Failure>(run: (tenant: Tenant) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* tenantScenario() {
    const pair = yield* loadDatabaseConnectionPair();
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig();
    const bootstrapConnection = yield* makeTestPgClient(pair.admin.connectionString, { maxConnections: 1 });
    const database = `access_agents_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(pair.admin.connectionString, database), {
      maxConnections: 2,
    });
    yield* createTemplateDatabase(admin);
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId);
    const runtime = yield* makeTestPgClient(replacedDatabase(pair.runtime.connectionString, database), {
      maxConnections: 3,
    });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    // The v2 half exists and carries the access types and the agent, and no legacy one: the set the recordings below
    // are held to.
    expect(ONTOS_SPICEDB_SCHEMA.indexOf(V2_MARKER)).toBeGreaterThan(0);
    expect(['access_scope', 'agent', 'legal_entity', 'principal'].map((type) => V2_DEFINITIONS.has(type))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const named: NamedTypes = { calls: [], types: new Set() };
    const compiler = makeAccessProjectionCompiler(
      recordingProjectionTransport(named, makeAccessProjectionTransport(configuration)),
    );
    const platforms = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      Layer.succeed(AccessProjectionCompiler, compiler),
      NodeServices.layer,
    );
    const stores = Layer.mergeAll(
      platforms,
      TenantIntentLoaderLive.pipe(Layer.provide(platforms)),
      AccessWriteJournalStoreLive.pipe(Layer.provide(platforms)),
      AccessChangesStoreLive.pipe(Layer.provide(platforms)),
      AccessMembershipStoreLive.pipe(Layer.provide(platforms)),
      AccessPeopleStoreLive.pipe(Layer.provide(platforms)),
      AccessPeopleDirectoryLive.pipe(Layer.provide(platforms)),
      AgentConnectionStoreLive.pipe(Layer.provide(platforms)),
      Layer.succeed(
        AccessTeamStore,
        makeAccessTeamDrizzleStore({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor }),
      ),
    );
    const base = Layer.mergeAll(
      stores,
      AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores)),
      AccessProjectionWriterLive.pipe(Layer.provide(stores)),
    );
    const context = yield* Layer.build(
      Layer.mergeAll(
        base,
        TenantAccessBootstrapLive.pipe(Layer.provide(base)),
        AccessDecisionLive.pipe(
          Layer.provide(recordingDecisionCheck(named)),
          Layer.provide(AccessEnforcementPortsLive),
          Layer.provide(base),
        ),
        AccessPeopleCommandsLive.pipe(Layer.provide(base)),
      ),
    );
    const ownerScope = yield* sessionScope(tenantId, owner);
    yield* Context.get(context, TenantAccessBootstrap)
      .bootstrapTenantAccess({ legalEntityIds: [company, otherCompany], modules, scope: ownerScope })
      .pipe(
        Effect.mapError((cause) => new Error(`${cause.code}: ${cause.reason}`)),
        Effect.orDie,
      );
    yield* seedMembers(admin, tenantId);
    const release = Option.getOrThrow(
      yield* Context.get(context, AccessPeopleStore).loadCatalogSnapshot(ownerScope).pipe(Effect.orDie),
    );
    const { cells } = yield* Effect.fromResult(compileFullAccessRole(release)).pipe(Effect.orDie);
    const cellsOf = (capabilityKeys: readonly string[]) =>
      cells.filter((cell) => capabilityKeys.includes(cell.capabilityKey));
    const createRole = (capabilityKeys: readonly string[], keep: (cell: Cell) => boolean = () => true) =>
      Effect.gen(function* createRoleEffect() {
        const kept = cellsOf(capabilityKeys).filter(keep);
        const [roleUuid, revisionUuid] = yield* Effect.all([crypto.randomUUIDv4(), crypto.randomUUIDv4()]);
        const created = yield* writeRoleCreation({
          catalogSnapshotId: release.id,
          cells: kept,
          decidedAt: yield* DateTime.nowAsDate,
          legalEntityId: company,
          name: `Role ${capabilityKeys.join('+')}`,
          scope: ownerScope,
          targetRevisionId: RoleRevisionIdSchema.make(revisionUuid),
          targetRoleId: RoleIdSchema.make(roleUuid),
        });
        return { roleId: created.roleId, roleRevisionId: created.roleRevisionId };
      }).pipe(Effect.provideContext(context), Effect.orDie);
    const editRole: Tenant['editRole'] = (role, before, cellsAfter) =>
      Effect.gen(function* editRoleEffect() {
        yield* writeRoleRevision({
          catalogSnapshotId: release.id,
          decidedAt: yield* DateTime.nowAsDate,
          edit: {
            addedCells: toSortedCells(without(cellsAfter, before)),
            cells: toSortedCells(cellsAfter),
            removedCells: toSortedCells(without(before, cellsAfter)),
            roleId: role.roleId,
            sourceRevisionId: role.roleRevisionId,
            targetRevisionId: RoleRevisionIdSchema.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
          },
          scope: ownerScope,
        });
        return Option.none();
      }).pipe(
        Effect.provideContext(context),
        Effect.catchTag('AccessChangesStoreConflictError', ({ code, reason }) => Effect.succeedSome({ code, reason })),
        Effect.orDie,
      );
    const result = yield* run({
      admin,
      cellsOf,
      connections: Context.get(context, AgentConnectionStore),
      createRole,
      editRole,
      gate: Context.get(context, AccessDecisionGate),
      newId: crypto.randomUUIDv4().pipe(Effect.orDie),
      owner: ownerScope,
      people: Context.get(context, AccessPeopleCommands),
      release,
      tenantId,
    });
    // SpiceDB was really reached (every tenant's bootstrap writes its projection), and no call this scenario made —
    // the gate's questions, the projection's reads and writes — named a type outside the v2 half: nothing in this
    // agent's path leaned on a legacy definition.
    expect(named.calls).toContain('write');
    expect([...named.types].filter((type) => !V2_DEFINITIONS.has(type)).toSorted()).toEqual([]);
    return result;
  }).pipe(Effect.scoped);

const decisionAt = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));
const connectionEnd = DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00Z'));
const companyScopeId = (tenant: Tenant) => legalEntityScopeId(tenant.tenantId, company);

const codesOf = (decision: AccessDecision) => decision.reasons.map(({ code }) => code);

const decideAs = (scope: OperationalScope, carrier: typeof readCarrier) =>
  AccessDecisionGate.pipe(
    Effect.flatMap((gate) => gate.decide({ carrier, legalEntityScope: 'required', now: decisionAt, scope })),
  );

const assign = (
  tenant: Tenant,
  actor: OperationalScope,
  holder: { readonly roleId: RoleId; readonly roleRevisionId: RoleRevisionId },
  who: 'agent' | PrincipalId,
) =>
  Effect.gen(function* assignEffect() {
    return yield* tenant.people.assignRole(actor, {
      holder: who === 'agent' ? { _tag: 'Agent', agentId: agent } : { _tag: 'Principal', principalId: who },
      incarnationId: AssignmentIncarnationIdSchema.make(yield* tenant.newId),
      roleId: holder.roleId,
      roleRevisionId: holder.roleRevisionId,
      scopeId: companyScopeId(tenant),
    });
  });

const admitAgent = (tenant: Tenant) =>
  Effect.gen(function* admitAgentEffect() {
    return yield* tenant.people.admitMember(tenant.owner, {
      companyMembershipId: AccessMembershipIdSchema.make(yield* tenant.newId),
      holder: { _tag: 'Agent', agentId: agent },
      legalEntityId: company,
      tenantMembershipId: AccessMembershipIdSchema.make(yield* tenant.newId),
    });
  });

/** The operator consents for the agent on one OAuth grant: the connection with the ceiling of the agent's cells. */
const connect = (tenant: Tenant, consenter: PrincipalId, capabilityKeys: readonly string[]) =>
  Effect.gen(function* connectEffect() {
    const grantId = yield* tenant.newId;
    const scope = yield* sessionScope(tenant.tenantId, consenter, company);
    const opened = yield* tenant.connections.open(scope, {
      agentId: agent,
      ceiling: consentCeilingOf({
        catalog: tenant.release.entries,
        cells: tenant.cellsOf(capabilityKeys),
        modules: 'all',
      }),
      connectionId: agentConnectionIdOfGrant(grantId),
      legalEntityId: company,
      validUntil: connectionEnd,
    });
    const mcp = yield* agentScope(tenant.tenantId, grantId, {
      connectionId: opened.connectionId,
      revision: opened.revision,
    });
    return { grantId, mcp, opened };
  });

/** The agent holding the read-only role, connected by its operator who holds everything. */
const connectedReader = (tenant: Tenant) =>
  Effect.gen(function* connectedReaderEffect() {
    const everything = yield* tenant.createRole([TASK_READ, TASK_CREATE, TASK_DELETE]);
    const reader = yield* tenant.createRole([TASK_READ]);
    yield* assign(tenant, tenant.owner, everything, operator);
    yield* admitAgent(tenant);
    const readerAssignment = yield* assign(tenant, tenant.owner, reader, 'agent');
    yield* seedOperators(tenant.admin, tenant.tenantId, [operator], 1);
    const connection = yield* connect(tenant, operator, [TASK_READ]);
    return { connection, everything, reader, readerAssignment };
  });

it.layer(NodeServices.layer, { excludeTestServices: true })('an agent on authorization v2', (suite) => {
  suite.effect('reads within its role as the agent, and nothing beyond the role or the consent', () =>
    withTenant((tenant) =>
      Effect.gen(function* withinTheRole() {
        const { connection, everything } = yield* connectedReader(tenant);
        // A role that runs a sensitive capability is never an agent's: the People rule refuses it before any write.
        const refused = yield* Effect.flip(assign(tenant, tenant.owner, everything, 'agent'));
        expect(refused.code).toBe('people_agent_holder_forbidden');
        // The agent's working role: routine reads and changes, and the sensitive change only as a proposal.
        const worker = yield* tenant.createRole(
          [TASK_READ, TASK_CREATE, TASK_DELETE],
          (cell) => cell.capabilityKey !== TASK_DELETE || cell.mode === 'propose',
        );
        const read = yield* decideAs(connection.mcp, readCarrier);
        expect(read.outcome).toBe('ALLOWED');
        // The role grants no change, so the agent changes nothing although its operator could.
        const create = yield* decideAs(connection.mcp, createCarrier);
        expect(create.outcome).toBe('DENIED');
        // A role given after the consent is not in the consent's ceiling: the connection stays as consented.
        yield* assign(tenant, tenant.owner, worker, 'agent');
        const afterRole = yield* decideAs(connection.mcp, createCarrier);
        expect(afterRole.outcome).toBe('DENIED');
        expect(codesOf(afterRole)).toContain('deny.connection_ceiling');
        // A new consent covers it: a routine change runs, a sensitive one is only a proposal a person decides.
        const reconnected = yield* connect(tenant, operator, [TASK_READ, TASK_CREATE, TASK_DELETE]);
        expect((yield* decideAs(reconnected.mcp, createCarrier)).outcome).toBe('ALLOWED');
        const sensitive = yield* decideAs(reconnected.mcp, deleteCarrier);
        expect(sensitive.outcome).toBe('NEEDS_APPROVAL');
        expect(codesOf(sensitive)).toContain('approval.required');
        // The agent never approves.
        const approve = yield* AccessDecisionGate.pipe(
          Effect.flatMap((gate) =>
            gate.decide({
              carrier: deleteCarrier,
              legalEntityScope: 'required',
              mode: 'approve',
              now: decisionAt,
              scope: reconnected.mcp,
            }),
          ),
        );
        expect(approve.outcome).toBe('DENIED');
      }).pipe(Effect.provideService(AccessDecisionGate, tenant.gate)),
    ),
  );

  suite.effect('is refused in another company, in another tenant and on its own API key', () =>
    withTenant((tenant) =>
      Effect.gen(function* otherScopes() {
        const { connection } = yield* connectedReader(tenant);
        const elsewhere = yield* agentScope(
          tenant.tenantId,
          connection.grantId,
          { connectionId: connection.opened.connectionId, revision: 1 },
          otherCompany,
        );
        expect((yield* decideAs(elsewhere, readCarrier)).outcome).toBe('DENIED');
        const foreignTenant = { ...connection.mcp, tenantId: TenantIdSchema.make(yield* tenant.newId) };
        expect((yield* decideAs(foreignTenant, readCarrier)).outcome).not.toBe('ALLOWED');
        // The agent's own API key carries no connection: proposing or running anything with it is refused, and it
        // selects no company, whatever role the agent holds.
        const apiKey = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          authBindingId: uid(302),
          authContextRef: 'better-auth-api-key:agent-key',
          authMethod: 'api_key',
          legalEntityId: company,
          principalId: agent,
          tenantId: tenant.tenantId,
        }).pipe(
          Effect.map(
            (context) => ({ ...context, correlationId: 'access-agent-authority:key' }) satisfies OperationalScope,
          ),
          Effect.orDie,
        );
        for (const carrier of [readCarrier, createCarrier]) {
          expect((yield* decideAs(apiKey, carrier)).outcome).toBe('DENIED');
          const proposed = yield* AccessDecisionGate.pipe(
            Effect.flatMap((gate) =>
              gate.decide({ carrier, legalEntityScope: 'required', mode: 'propose', now: decisionAt, scope: apiKey }),
            ),
          );
          expect(proposed.outcome).toBe('DENIED');
        }
        expect(yield* tenant.gate.selectableLegalEntities({ now: decisionAt, scope: apiKey })).toEqual([]);
        // A consent granted in one company answers for that company only: with the agent admitted and connected in
        // the other company, its company list never includes the company whose role it actually holds.
        expect(yield* tenant.gate.selectableLegalEntities({ now: decisionAt, scope: connection.mcp })).toEqual([
          company,
        ]);
        yield* tenant.admin
          .unsafe(
            `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
             values ('${tenant.tenantId}', '${otherCompany}', '${agent}', null, 'active')`,
          )
          .pipe(Effect.orDie);
        const elsewhereGrant = yield* tenant.newId;
        const openedElsewhere = yield* tenant.connections.open(
          yield* sessionScope(tenant.tenantId, operator, otherCompany),
          {
            agentId: agent,
            ceiling: consentCeilingOf({
              catalog: tenant.release.entries,
              cells: tenant.cellsOf([TASK_READ]),
              modules: 'all',
            }),
            connectionId: agentConnectionIdOfGrant(elsewhereGrant),
            legalEntityId: otherCompany,
            validUntil: connectionEnd,
          },
        );
        const elsewhereScope = yield* agentScope(
          tenant.tenantId,
          elsewhereGrant,
          { connectionId: openedElsewhere.connectionId, revision: openedElsewhere.revision },
          otherCompany,
        );
        const selectableElsewhere = yield* tenant.gate.selectableLegalEntities({
          now: decisionAt,
          scope: elsewhereScope,
        });
        expect(selectableElsewhere).not.toContain(company);
      }).pipe(Effect.provideService(AccessDecisionGate, tenant.gate)),
    ),
  );

  suite.effect('is connected only by a current operator, and only while it is an active agent of the company', () =>
    withTenant((tenant) =>
      Effect.gen(function* onlyOperators() {
        const { connection } = yield* connectedReader(tenant);
        const operatorScope = yield* sessionScope(tenant.tenantId, operator, company);
        const retry = tenant.connections.open(operatorScope, {
          agentId: agent,
          ceiling: { cells: [] },
          connectionId: connection.opened.connectionId,
          legalEntityId: company,
          validUntil: connectionEnd,
        });
        // A retried consent of the operator's own active connection is confirmed while everything still holds.
        expect((yield* retry).connectionId).toBe(connection.opened.connectionId);
        const bystanderScope = yield* sessionScope(tenant.tenantId, bystander, company);
        const notOperator = yield* Effect.flip(
          tenant.connections.open(bystanderScope, {
            agentId: agent,
            ceiling: { cells: [] },
            connectionId: agentConnectionIdOfGrant(yield* tenant.newId),
            legalEntityId: company,
            validUntil: connectionEnd,
          }),
        );
        expect(notOperator).toMatchObject({ _tag: 'AgentConnectionRefused', code: 'agent_connection_not_operator' });
        // The operator is removed: they can no longer connect, and the live facts say so on the next request.
        yield* seedOperators(tenant.admin, tenant.tenantId, [bystander], 2);
        const removed = yield* Effect.flip(connect(tenant, operator, [TASK_READ]));
        expect(removed).toMatchObject({ code: 'agent_connection_not_operator' });
        // A retry of the consent is re-checked too: the removed operator's retry is refused, not confirmed.
        expect(yield* Effect.flip(retry)).toMatchObject({ code: 'agent_connection_not_operator' });
        const facts = yield* tenant.connections.liveFacts(operatorScope, {
          agentId: agent,
          connectionId: agentConnectionIdOfGrant(yield* tenant.newId),
          legalEntityId: company,
          operatorPrincipalId: operator,
        });
        expect(facts.operatorHolds).toBe(false);
        // A disabled agent is not an active agent of the company: nothing connects it and the live check fails.
        yield* tenant.admin
          .unsafe(`update core.principals set status = 'disabled' where principal_id = '${agent}'`)
          .pipe(Effect.orDie);
        const disabled = yield* tenant.connections.liveFacts(operatorScope, {
          agentId: agent,
          connectionId: agentConnectionIdOfGrant(yield* tenant.newId),
          legalEntityId: company,
          operatorPrincipalId: bystander,
        });
        expect(disabled.agentInCompany).toBe(false);
        const bystanderAgain = yield* sessionScope(tenant.tenantId, bystander, company);
        const inactive = yield* Effect.flip(
          tenant.connections.open(bystanderAgain, {
            agentId: agent,
            ceiling: { cells: [] },
            connectionId: agentConnectionIdOfGrant(yield* tenant.newId),
            legalEntityId: company,
            validUntil: connectionEnd,
          }),
        );
        expect(inactive).toMatchObject({ code: 'agent_connection_agent_inactive' });
      }),
    ),
  );

  suite.effect('loses its authority on the next decision when its connection, role or membership ends', () =>
    withTenant((tenant) =>
      Effect.gen(function* revocations() {
        const { connection, readerAssignment } = yield* connectedReader(tenant);
        expect((yield* decideAs(connection.mcp, readCarrier)).outcome).toBe('ALLOWED');
        const selectable = (mcp: OperationalScope) =>
          tenant.gate.selectableLegalEntities({ now: decisionAt, scope: mcp });
        expect(yield* selectable(connection.mcp)).toEqual([company]);
        // The grant is revoked: its connection ends with it.
        const operatorScope = yield* sessionScope(tenant.tenantId, operator, company);
        yield* tenant.connections.revoke(operatorScope, connection.opened.connectionId);
        const revoked = yield* decideAs(connection.mcp, readCarrier);
        expect(revoked.outcome).toBe('DENIED');
        expect(codesOf(revoked)).toEqual(['deny.connection_inactive']);
        // The company list re-reads the connection row too: a revoked connection selects nothing.
        expect(yield* selectable(connection.mcp)).toEqual([]);
        // A new connection works again; then the role is removed through the People commands.
        const second = yield* connect(tenant, operator, [TASK_READ]);
        expect((yield* decideAs(second.mcp, readCarrier)).outcome).toBe('ALLOWED');
        const incarnation = yield* Effect.fromOption(
          Option.fromUndefinedOr(readerAssignment.assignment?.incarnationId),
        ).pipe(Effect.orDie);
        yield* tenant.people.unassignRole(tenant.owner, { incarnationId: incarnation });
        expect((yield* decideAs(second.mcp, readCarrier)).outcome).toBe('DENIED');
        // The role is back, then the agent leaves the company: its membership path ends and so does everything.
        const reader = yield* tenant.createRole([TASK_READ]);
        yield* assign(tenant, tenant.owner, reader, 'agent');
        expect((yield* decideAs(second.mcp, readCarrier)).outcome).toBe('ALLOWED');
        yield* tenant.people.endMembership(tenant.owner, {
          holder: { _tag: 'Agent', agentId: agent },
          reason: 'Agent ukončen',
          scopeId: companyScopeId(tenant),
        });
        expect((yield* decideAs(second.mcp, readCarrier)).outcome).toBe('DENIED');
      }).pipe(Effect.provideService(AccessDecisionGate, tenant.gate)),
    ),
  );

  suite.effect('gets roles only from someone who may assign them under the People rule', () =>
    withTenant((tenant) =>
      Effect.gen(function* peopleRule() {
        const reader = yield* tenant.createRole([TASK_READ]);
        yield* admitAgent(tenant);
        // A plain member administers nothing here, so they neither assign a role to the agent nor admit it.
        const bystanderScope = yield* sessionScope(tenant.tenantId, bystander);
        const refused = yield* Effect.flip(assign(tenant, bystanderScope, reader, 'agent'));
        expect(refused.code).toBe('people_authority_missing');
        // An agent never holds administration.
        const admin = yield* Effect.flip(
          tenant.people.endMembership(bystanderScope, {
            holder: { _tag: 'Agent', agentId: agent },
            reason: 'x',
            scopeId: companyScopeId(tenant),
          }),
        );
        expect(admin.code).toBe('people_authority_missing');
      }),
    ),
  );

  suite.effect('keeps a role an agent holds free of sensitive runs, and never stops the tenant over one', () =>
    withTenant((tenant) =>
      Effect.gen(function* sensitiveRole() {
        const { everything } = yield* connectedReader(tenant);
        const reconnected = yield* connect(tenant, operator, [TASK_READ, TASK_CREATE, TASK_DELETE]);
        // (a) The role editor refuses to make a role an agent holds run a sensitive capability, and names the agent.
        const proposesOnly = (cell: Cell) => cell.capabilityKey !== TASK_DELETE || cell.mode === 'propose';
        const worker = yield* tenant.createRole([TASK_READ, TASK_CREATE, TASK_DELETE], proposesOnly);
        yield* assign(tenant, tenant.owner, worker, 'agent');
        const all = tenant.cellsOf([TASK_READ, TASK_CREATE, TASK_DELETE]);
        const before = all.filter(proposesOnly);
        const refused = Option.getOrThrow(yield* tenant.editRole(worker, before, all));
        expect(refused.code).toBe('access_changes_write_refused');
        expect(refused.reason).toContain('Agent úkolů');
        // A routine edit of the same role is recorded as usual.
        expect(yield* tenant.editRole(worker, before, tenant.cellsOf([TASK_READ, TASK_CREATE]))).toStrictEqual(
          Option.none(),
        );
        // (b) A sensitive role that reached the agent anyway (written past both rules) is withheld from the
        // projection: the agent gets none of its cells, its other roles keep working, and the tenant's other
        // writes still project.
        yield* tenant.admin
          .unsafe(
            `insert into core.access_assignments
               (incarnation_id, tenant_id, scope_id, agent_id, role_id, role_revision_id, status, valid_from, assigned_by)
             values ('${yield* tenant.newId}', '${tenant.tenantId}', '${companyScopeId(tenant)}', '${agent}',
                     '${everything.roleId}', '${everything.roleRevisionId}', 'active', now() - interval '1 hour',
                     '${owner}')`,
          )
          .pipe(Effect.orDie);
        const reader = yield* tenant.createRole([TASK_READ]);
        yield* assign(tenant, tenant.owner, reader, bystander).pipe(Effect.orDie);
        const bystanderScope = yield* sessionScope(tenant.tenantId, bystander, company);
        expect((yield* decideAs(bystanderScope, readCarrier)).outcome).toBe('ALLOWED');
        expect((yield* decideAs(reconnected.mcp, readCarrier)).outcome).toBe('ALLOWED');
        expect((yield* decideAs(reconnected.mcp, createCarrier)).outcome).toBe('ALLOWED');
        expect((yield* decideAs(reconnected.mcp, deleteCarrier)).outcome).toBe('DENIED');
      }).pipe(Effect.provideService(AccessDecisionGate, tenant.gate)),
    ),
  );

  suite.effect('is decided on both sides and within its consent in batches, listings and up to its deadline', () =>
    withTenant((tenant) =>
      Effect.gen(function* bothSides() {
        // The operator only reads; the agent's role also changes and proposes deletions.
        const reader = yield* tenant.createRole([TASK_READ]);
        const worker = yield* tenant.createRole(
          [TASK_READ, TASK_CREATE, TASK_DELETE],
          (cell) => cell.capabilityKey !== TASK_DELETE || cell.mode === 'propose',
        );
        const operatorAssignment = yield* assign(tenant, tenant.owner, reader, operator);
        yield* admitAgent(tenant);
        yield* assign(tenant, tenant.owner, worker, 'agent');
        yield* seedOperators(tenant.admin, tenant.tenantId, [operator], 1);
        const full = yield* connect(tenant, operator, [TASK_READ, TASK_CREATE, TASK_DELETE]);
        const ask = (mcp: OperationalScope, carrier: typeof readCarrier, now = decisionAt) => ({
          carrier,
          legalEntityScope: 'required' as const,
          now,
          scope: mcp,
        });
        // The agent's broad role never reaches past its operator: what the operator lacks, the agent lacks too.
        const batch = yield* tenant.gate.decideMany(
          [readCarrier, createCarrier, deleteCarrier].map((carrier) => ask(full.mcp, carrier)),
        );
        expect(batch.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'DENIED', 'DENIED']);
        const listed = yield* tenant.gate.list(ask(full.mcp, readCarrier));
        expect(listed.decision.outcome).toBe('ALLOWED');
        // A consent that left reading out holds in a batch and in a listing as in a single decision.
        const narrow = yield* connect(tenant, operator, [TASK_CREATE]);
        const [narrowRead] = yield* tenant.gate.decideMany([ask(narrow.mcp, readCarrier)]);
        expect(narrowRead?.outcome).toBe('DENIED');
        expect(codesOf(narrowRead ?? listed.decision)).toContain('deny.connection_ceiling');
        const narrowList = yield* tenant.gate.list(ask(narrow.mcp, readCarrier));
        expect(narrowList.decision.outcome).toBe('DENIED');
        expect(narrowList.predicate).toBeUndefined();
        // The consent stands until its deadline (365 days from consent in the product) and not a moment longer.
        const lapsed = yield* tenant.gate.decide(ask(full.mcp, readCarrier, connectionEnd));
        expect(lapsed.outcome).toBe('DENIED');
        expect(codesOf(lapsed)).toEqual(['deny.connection_inactive']);
        // Rights the operator loses AFTER the consent end the agent's authority on the next decision: the consent is
        // a ceiling, never a right of its own.
        const operatorIncarnation = yield* Effect.fromOption(
          Option.fromUndefinedOr(operatorAssignment.assignment?.incarnationId),
        ).pipe(Effect.orDie);
        yield* tenant.people.unassignRole(tenant.owner, { incarnationId: operatorIncarnation });
        const afterNarrowing = yield* tenant.gate.decide(ask(full.mcp, readCarrier));
        expect(afterNarrowing.outcome).toBe('DENIED');
      }),
    ),
  );
});
