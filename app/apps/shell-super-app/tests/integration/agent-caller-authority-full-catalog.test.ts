import { v1 } from '@authzed/authzed-node';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionSnapshotSchema,
  loadDatabaseConnectionPair,
  makeDatabaseIdentityEnrollmentLive,
  OntosDeploymentAppIdSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  parseDatabaseConnectionPair,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot, DatabaseConnectionPair } from '@app/core-runtime';
import { AccessCatalogModulesSchema } from '@app/core-runtime/access/catalog';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import {
  AccessDecisionLive,
  AccessDecisionLogBatchLive,
  AccessDecisionLogLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  ActionAuthority,
  ActionAuthorityLive,
  LegalEntityCandidatesLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import type { PgClient } from '@effect/sql-pg';
import { Config, Crypto, DateTime, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Tracer } from 'effect';
import { expect, it } from 'effect-rstest';

import { withOptional } from '../../../../packages/core-runtime/src/access/decision/optional.ts';
import { DecisionCheck } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import type { DecisionCheckPort } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import { enginePortOf } from '../../../../packages/core-runtime/src/access/enforcement/enforcement-live.ts';
import { ActiveApplicationCompositionSource } from '../../../../packages/core-runtime/src/modules/active-application-composition-source-service.ts';
import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '../../../../packages/core-runtime/src/modules/module-dependency-contracts.ts';
import { SPICEDB_CHECK_TIMEOUT_MS } from '../../../../packages/core-runtime/src/permissions/client.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { spiceDbTransport } from '../../../../packages/core-runtime/src/permissions/spicedb-transport.node.ts';
import { deriveOntosModuleDeploymentContract } from '../../../../scripts/generate-ontos-module-contract.mts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';
import { callerModuleAccess, emptyCallerAccessTrace, moduleCarriers } from '../../api/agent-platform/caller.ts';
import {
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogLive,
} from '../../api/modules/installed-module-catalog.ts';
import { declaredActionAuthorities } from '../../../../packages/core-runtime/src/permissions/action-authority.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  buildAccessGraph,
  replacedDatabase,
  templateDatabaseLayer,
} from '../support/access-admin-real-gate-fixture.ts';

/*
 * The agent platform's caller authority, measured against the real stack: `callerModuleAccess` and the Action
 * authority a proposal queue read asks, for a tenant owner in its company, over the composition of every module the
 * release installs, the real access gate and Action authority, the real intent loader under the Shell's runtime
 * database role and the integration SpiceDB. Each is compared with the same questions asked one at a time, as they
 * were before they were batched: identical answers, identical evidence rows, far fewer round trips.
 */

const releaseIntentPath = new URL('../../../../topology/application-release-intent.json', import.meta.url);
const ReleaseIntentSchema = Schema.fromJsonString(
  Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: OntosDeploymentAppIdSchema })) }),
);

const installedComposition = Effect.gen(function* installedComposition() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const intent = yield* Schema.decodeUnknownEffect(ReleaseIntentSchema)(
    yield* fileSystem.readFileString(yield* path.fromFileUrl(releaseIntentPath)),
  );
  const contracts = yield* Effect.forEach(
    intent.modules,
    ({ appId }) => deriveOntosModuleDeploymentContract({ vertical: appId }),
    { concurrency: 4 },
  );
  // The Shell runtime contract a release publishes: the fixture receiver plus the Core capability it provides.
  const receiverDeployment = { appId: 'shell-super-app', buildMarker: ultramodernDeliveryUnit.buildMarker } as const;
  const document = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
    deployment: receiverDeployment,
    schemaVersion: '2',
  });
  return yield* makeCompositionSnapshot(contracts, 600_000, { document, receiverDeployment });
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

interface SpanRecord {
  readonly ms: number;
  readonly name: string;
}

/** A tracer that keeps every finished span's name and duration; database and engine calls are spans of their own. */
const recordingTracer = (records: SpanRecord[]) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        records.push({ ms: Number(endTime - options.startTime) / 1e6, name: options.name });
      };
      return span;
    },
  });

interface Counters {
  checkBulk: number;
  checkItems: number;
  compositionLoads: number;
}

const countedCheck = (port: DecisionCheckPort, counters: Counters): DecisionCheckPort => ({
  checkBulk: (items) =>
    Effect.suspend(() => {
      counters.checkBulk += 1;
      counters.checkItems += items.length;
      return port.checkBulk(items);
    }),
});

/** The Shell's gate and Action authority over this case's runtime database role, SpiceDB and the installed release. */
const gateLayer = (input: {
  readonly authorityCase: AuthorityCase;
  readonly counters: Counters;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) =>
  Layer.unwrap(
    Effect.gen(function* buildGate() {
      const database = yield* makeCoreDatabase(input.authorityCase.runtime);
      const configuration = yield* loadSpiceDbConfig();
      const rpc = yield* Effect.acquireRelease(
        Effect.sync(() => spiceDbTransport.open(configuration, SPICEDB_CHECK_TIMEOUT_MS)),
        (opened) => Effect.sync(() => opened.close()),
      );
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
        input.snapshot,
      );
      const composition = ActiveApplicationCompositionConfigLive.pipe(
        Layer.provide(
          Layer.succeed(ActiveApplicationCompositionSource, {
            load: Effect.sync(() => {
              input.counters.compositionLoads += 1;
              return encoded;
            }),
          }),
        ),
      );
      const base = Layer.mergeAll(
        Layer.succeed(CoreDatabase, database),
        makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
        NodeServices.layer,
      );
      const ports = Layer.mergeAll(
        AccessIntentLive.pipe(Layer.provide(TenantIntentLoaderLive)),
        AccessDecisionLogLive,
        AccessDecisionLogBatchLive,
        AccessPrincipalKindSourceLive,
        LegalEntityCandidatesLive,
        Layer.succeed(DecisionCheck, countedCheck(enginePortOf(rpc), input.counters)),
        composition,
      ).pipe(Layer.provideMerge(base));
      const gate = AccessDecisionLive.pipe(Layer.provideMerge(ports));
      return Layer.mergeAll(
        ActionAuthorityLive.pipe(Layer.provideMerge(gate)),
        ShellInstalledModuleCatalogLive.pipe(Layer.provide(composition)),
        TenantModuleStateServiceLive.pipe(Layer.provide(base)),
      );
    }),
  );

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const catalogArtifactPath = new URL('../../../../topology/authorization-catalog.json', import.meta.url);
const TEMPLATE_DATABASE = 'p14_access_admin_template';

const publishedCatalog = Effect.gen(function* publishedCatalog() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifact = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema, schemaVersion: Schema.Number })),
  )(yield* fileSystem.readFileString(yield* path.fromFileUrl(catalogArtifactPath)));
  return artifact.modules;
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

/** A signed-in staff session's trusted scope; `correlationId` tags the evidence rows its reads write. */
const sessionScope = (input: {
  readonly correlationId: string;
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
    withOptional(
      {
        authBindingId: input.principalId,
        authContextRef: `session:acting-authority:${input.principalId}`,
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session',
        principalId: input.principalId,
        tenantId: input.tenantId,
      },
      'legalEntityId',
      input.legalEntityId,
    ),
  ).pipe(
    Effect.map((context): OperationalScope => ({ ...context, correlationId: input.correlationId })),
    Effect.orDie,
  );

interface AuthorityCase {
  /** The case database's administrator client, for reading back the evidence rows a read wrote. */
  readonly admin: PgClient.PgClient;
  readonly companyId: string;
  /** Gives `person` a role with every `run` capability of `moduleKey` in that company, projected at once. */
  readonly grant: (moduleKey: string, legalEntityId: string) => Effect.Effect<void>;
  /** The tenant's second company, where `person` is a member holding nothing until granted. */
  readonly otherCompanyId: string;
  readonly owner: string;
  readonly person: string;
  /** Leaves exactly these modules installed for the tenant and reprojects its graph through the Core writer. */
  readonly reinstall: (moduleKeys: readonly string[]) => Effect.Effect<void>;
  readonly runtime: DatabaseConnectionPair['runtime'];
  readonly tenantId: string;
}

/**
 * One cloned database with one tenant, two companies, its bootstrapped owner and one person who is a member of both
 * and holds a role with every `run` capability of `moduleId` in the first, projected into SpiceDB by the one Core writer.
 */
/** The access scope of `legalEntityId` among the tenant's scopes. */
const scopeIdOf = (
  scopeIds: readonly { readonly legal_entity_id: string | null; readonly scope_id: string }[],
  legalEntityId: string,
) => scopeIds.find(({ legal_entity_id: scoped }) => scoped === legalEntityId)?.scope_id;

/** One `run` cell over everything for each `run` capability `moduleKey` declares. */
const runCellsOf = (catalog: typeof AccessCatalogModulesSchema.Type, moduleKey: string) =>
  catalog
    .flatMap(({ descriptors }) => descriptors.map(({ accessDeclaration }) => accessDeclaration))
    .flatMap((declaration) =>
      declaration !== undefined && declaration.key.startsWith(`${moduleKey}.`) && declaration.modes.includes('run')
        ? [{ capabilityKey: declaration.key, mode: 'run', selector: { _tag: 'all' } }]
        : [],
    );

const withAuthorityCase = <A, E>(moduleId: string, run: (authorityCase: AuthorityCase) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* authorityCase() {
      const crypto = yield* Crypto.Crypto;
      const server = yield* loadDatabaseConnectionPair();
      const caseDatabase = `acting_authority_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
      const serverAdmin = yield* makeTestPgClient(server.admin.connectionString, { maxConnections: 1 });
      yield* serverAdmin.unsafe(`create database "${caseDatabase}" template "${TEMPLATE_DATABASE}"`);
      yield* Effect.addFinalizer(() =>
        serverAdmin.unsafe(`drop database if exists "${caseDatabase}" with (force)`).pipe(Effect.orDie),
      );
      const databases = yield* parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: replacedDatabase(server.admin.connectionString, caseDatabase),
        DATABASE_URL: replacedDatabase(server.runtime.connectionString, caseDatabase),
      });
      const admin = yield* makeTestPgClient(databases.admin.connectionString, { maxConnections: 2 });
      const configuration = yield* loadSpiceDbConfig();
      yield* Effect.acquireUseRelease(
        Effect.sync(() => newSpiceDbGrpcClient(configuration)),
        (client) =>
          Effect.tryPromise(
            async () =>
              await client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
          ),
        (client) => Effect.sync(() => client.close()),
      );
      const catalog = yield* publishedCatalog;
      const tenantId = yield* crypto.randomUUIDv4();
      const companyId = yield* crypto.randomUUIDv4();
      const otherCompanyId = yield* crypto.randomUUIDv4();
      const owner = yield* crypto.randomUUIDv4();
      const person = yield* crypto.randomUUIDv4();
      yield* admin.unsafe(
        `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ('${tenantId}', 'acting-${tenantId.slice(0, 8)}', 'Acting authority tenant', 'active', 'cs')`,
      );
      for (const legalEntityId of [companyId, otherCompanyId]) {
        yield* admin.unsafe(
          `insert into core.legal_entities
             (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
           values ('${legalEntityId}', '${tenantId}', 'Acting authority company', 'CZ', '${legalEntityId.slice(-8)}',
                   'active')`,
        );
      }
      for (const principalId of [owner, person]) {
        yield* admin.unsafe(
          `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
           values ('${principalId}', '${tenantId}', 'human', 'Acting authority person', 'active')`,
        );
      }
      for (const { moduleId: moduleKey } of catalog) {
        yield* admin.unsafe(
          `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state)
           values (gen_random_uuid(), '${tenantId}', '${moduleKey}', 'active')`,
        );
      }
      const graph = yield* buildAccessGraph({ adminUrl: databases.runtime.connectionString, configuration });
      const ownerScope = yield* sessionScope({ correlationId: 'acting-authority-seed', principalId: owner, tenantId });
      const bootstrap = yield* graph.bootstrap.bootstrapTenantAccess({
        legalEntityIds: [LegalEntityIdSchema.make(companyId), LegalEntityIdSchema.make(otherCompanyId)],
        modules: catalog,
        scope: ownerScope,
      });
      const scopeIds = yield* admin.unsafe<{ readonly legal_entity_id: string | null; readonly scope_id: string }>(
        `select scope_id, legal_entity_id from core.access_scopes where tenant_id = '${tenantId}'`,
      );
      for (const { scope_id: scopeId } of scopeIds) {
        yield* admin.unsafe(
          `insert into core.access_memberships
             (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
           values (gen_random_uuid(), '${tenantId}', '${scopeId}', '${person}', 'member', 'active',
                   now() - interval '1 day', '${owner}')`,
        );
      }
      const grantRole = (moduleKey: string, legalEntityId: string) =>
        Effect.gen(function* grantRoleOf() {
          const grantScopeId = scopeIdOf(scopeIds, legalEntityId);
          const cells = runCellsOf(catalog, moduleKey);
          const roleId = yield* crypto.randomUUIDv4();
          const roleRevisionId = yield* crypto.randomUUIDv4();
          yield* admin.unsafe(
            `insert into core.access_roles (role_id, tenant_id, created_by, name)
             values ('${roleId}', '${tenantId}', '${owner}', 'Module ${moduleKey} ${legalEntityId.slice(-4)}')`,
          );
          yield* admin.unsafe(
            `insert into core.access_role_revisions
               (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
             values ('${roleRevisionId}', '${tenantId}', '${roleId}', 1, '${bootstrap.catalogSnapshotId}',
                     '${jsonText(cells)}'::jsonb, '${owner}', 'manual')`,
          );
          for (const cell of cells) {
            yield* admin.unsafe(
              `insert into core.access_grant_incarnations
                 (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
               values (gen_random_uuid(), '${tenantId}', '${grantScopeId}', '${roleId}', '${cell.capabilityKey}',
                       'run', 'all', '${jsonText(cell)}'::jsonb, 'active')`,
            );
          }
          yield* admin.unsafe(
            `insert into core.access_assignments
               (incarnation_id, tenant_id, scope_id, principal_id, role_id, role_revision_id, status, assigned_by,
                valid_from)
             values (gen_random_uuid(), '${tenantId}', '${grantScopeId}', '${person}', '${roleId}',
                     '${roleRevisionId}', 'active', '${owner}', now() - interval '1 day')`,
          );
        });
      yield* grantRole(moduleId, companyId);
      yield* graph.writer.reconcileTenant({ scope: ownerScope });
      const reinstall = (moduleKeys: readonly string[]) =>
        Effect.gen(function* reinstallModules() {
          yield* admin.unsafe(`delete from core.tenant_module_states where tenant_id = '${tenantId}'`);
          for (const moduleKey of moduleKeys) {
            yield* admin.unsafe(
              `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state)
               values (gen_random_uuid(), '${tenantId}', '${moduleKey}', 'active')`,
            );
          }
          yield* graph.writer.reconcileTenant({ scope: ownerScope });
        }).pipe(Effect.orDie);
      const grant = (moduleKey: string, legalEntityId: string) =>
        grantRole(moduleKey, legalEntityId).pipe(
          Effect.andThen(graph.writer.reconcileTenant({ scope: ownerScope })),
          Effect.asVoid,
          Effect.orDie,
        );
      return yield* run({
        admin,
        companyId,
        grant,
        otherCompanyId,
        owner,
        person,
        reinstall,
        runtime: databases.runtime,
        tenantId,
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

const tally = (records: readonly SpanRecord[]) => {
  const byName = new Map<string, { count: number; ms: number }>();
  for (const { ms, name } of records) {
    const entry = byName.get(name) ?? { count: 0, ms: 0 };
    byName.set(name, { count: entry.count + 1, ms: entry.ms + ms });
  }
  return byName;
};

const countOf = (spans: ReadonlyMap<string, { readonly count: number }>, name: string) => spans.get(name)?.count ?? 0;

/** One measured read: what it answered, the round trips it made and the evidence rows it left. */
const measured = <A, E, R>(input: {
  readonly authorityCase: AuthorityCase;
  readonly correlationId: string;
  readonly read: Effect.Effect<A, E, R>;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) =>
  Effect.gen(function* measuredRead() {
    const counters: Counters = { checkBulk: 0, checkItems: 0, compositionLoads: 0 };
    const records: SpanRecord[] = [];
    const value = yield* input.read.pipe(
      Effect.withSpan('measured.read'),
      Effect.withTracer(recordingTracer(records)),
      Effect.provide(gateLayer({ authorityCase: input.authorityCase, counters, snapshot: input.snapshot })),
    );
    const [rows] = yield* input.authorityCase.admin.unsafe<{ readonly count: number }>(
      `select count(*)::int as count from core.access_decision_logs where correlation_id = '${input.correlationId}'`,
    );
    // Every row's content: all columns except its own id, the correlation it was tagged with and its instant.
    const contents = yield* input.authorityCase.admin.unsafe<{ readonly content: string }>(
      `select concat_ws('|', actor_principal_id, actor_json::text, capability_key, mode, outcome, reasons_json::text,
                        scope_id, coalesce(target::text, '-'), tenant_id, coalesce(admission_deadline::text, '-'), coalesce(delegate_app_id::text, '-'), coalesce(delegate_principal_id::text, '-'),
                        coalesce(on_behalf_of_principal_id::text, '-'), coalesce(operation_id::text, '-')) as content
         from core.access_decision_logs where correlation_id = '${input.correlationId}' order by content`,
    );
    const spans = tally(records);
    return {
      cellReads: countOf(spans, 'TenantIntentLoader.loadAuthorityCells'),
      counters,
      decisionRowContents: contents.map(({ content }) => content),
      decisionRows: rows?.count ?? -1,
      // Wall time of the read itself, from the span the recording tracer closed around it.
      ms: Math.round(spans.get('measured.read')?.ms ?? -1),
      spans,
      statements: countOf(spans, 'postgres'),
      transactions: countOf(spans, 'sql.transaction'),
      value,
    };
  });

const reportOf = (result: Effect.Success<ReturnType<typeof measured>>) => ({
  cellReads: result.cellReads,
  counters: result.counters,
  decisionRows: result.decisionRows,
  ms: result.ms,
  slowest: [...result.spans.entries()]
    .toSorted(([, left], [, right]) => right.ms - left.ms)
    .slice(0, 25)
    .map(([name, { count, ms }]) => ({ count, ms: Math.round(ms), name })),
  statements: result.statements,
  transactions: result.transactions,
});

/** Every Action of the installed release, as the gate asks it: the old one-at-a-time loop and the batch ask the same. */
const actionQuestionsOf = (installed: Effect.Success<(typeof ShellInstalledModuleCatalog)['Service']['load']>) => {
  const declared = declaredActionAuthorities(installed);
  const actions = installed.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
  );
  const actionKeys = [...new Set(actions.map(({ actionKey }) => actionKey))];
  return { actionKeys, actions, declared };
};

/** One Action question exactly as the Action authority builds it. */
const questionOf = (
  declared: ReturnType<typeof declaredActionAuthorities>,
  actionKey: string,
  scope: OperationalScope,
  now: Date,
): GateInput => ({
  carrier: declared.get(actionKey)?.carrier ?? {},
  legalEntityScope: declared.get(actionKey)?.legalEntityScope ?? 'optional',
  now,
  scope,
});

/** The Action authority as it was: one gate decision per Action, one at a time. */
const actionsOneAtATime = (actionKeys: readonly string[], scope: OperationalScope) =>
  Effect.gen(function* askActionsOneAtATime() {
    const installed = yield* (yield* ShellInstalledModuleCatalog).load;
    const { declared } = actionQuestionsOf(installed);
    const gate = yield* AccessDecisionGate;
    const now = yield* DateTime.nowAsDate;
    return yield* Effect.forEach(
      actionKeys,
      (actionKey) =>
        gate.decide(questionOf(declared, actionKey, scope, now)).pipe(
          Effect.map(({ outcome }) => ({
            actionKey,
            execute: outcome === 'ALLOWED' ? 'allowed' : 'denied',
            propose: outcome === 'DENIED' ? 'denied' : 'allowed',
          })),
        ),
      { concurrency: 1 },
    );
  });

/** `callerModuleAccess` as it was: one carrier batch, every LIST one at a time, every Action one at a time. */
const callerAccessOneAtATime = (scope: OperationalScope) =>
  Effect.gen(function* askCallerAccessOneAtATime() {
    const installed = yield* (yield* ShellInstalledModuleCatalog).load;
    const gate = yield* AccessDecisionGate;
    const now = yield* DateTime.nowAsDate;
    const carriers = moduleCarriers(installed);
    const listing = (carrier: (typeof carriers)[number]) =>
      carrier.declaration?.kind === 'read' && carrier.declaration.selectors.length > 0;
    const questionFor = (carrier: (typeof carriers)[number]) => ({
      carrier: { accessDeclaration: carrier.declaration },
      legalEntityScope: carrier.legalEntityScope,
      now,
      scope,
    });
    const scopeWide = carriers.filter((carrier) => !listing(carrier));
    const recordScoped = carriers.filter(listing);
    const batched = yield* gate.decideMany(scopeWide.map(questionFor));
    const listed = yield* Effect.forEach(
      recordScoped,
      (carrier) => gate.list(questionFor(carrier)).pipe(Effect.map(({ decision }) => decision)),
      { concurrency: 1 },
    );
    const access = new Set<string>();
    for (const [index, carrier] of scopeWide.entries()) {
      const outcome = batched[index]?.outcome;
      if (outcome === 'ALLOWED' || outcome === 'NEEDS_APPROVAL') {
        access.add(carrier.moduleId);
      }
    }
    for (const [index, carrier] of recordScoped.entries()) {
      const outcome = listed[index]?.outcome;
      if (outcome === 'ALLOWED' || outcome === 'NEEDS_APPROVAL') {
        access.add(carrier.moduleId);
      }
    }
    const { actionKeys, actions } = actionQuestionsOf(installed);
    const answers = yield* actionsOneAtATime(actionKeys, scope);
    const executable = new Set(answers.flatMap((answer) => (answer.execute === 'allowed' ? [answer.actionKey] : [])));
    const proposable = new Set(answers.flatMap((answer) => (answer.propose === 'allowed' ? [answer.actionKey] : [])));
    for (const action of actions) {
      if (executable.has(action.actionKey) || proposable.has(action.actionKey)) {
        access.add(action.owningModuleId);
      }
    }
    return {
      access,
      propose: new Set(actions.flatMap((action) => (proposable.has(action.actionKey) ? [action.owningModuleId] : []))),
      write: new Set(actions.flatMap((action) => (executable.has(action.actionKey) ? [action.owningModuleId] : []))),
    };
  });

/** The Action authority a proposal queue read asks in its preparation: every own Action of every installed module. */
const queueReadActionKeys = Effect.gen(function* queueReadActionKeys() {
  const installed = yield* (yield* ShellInstalledModuleCatalog).load;
  return installed.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.flatMap((action) =>
      action.owningModuleId === manifest.module.id && action.legalEntityScope !== 'forbidden' ? [action.actionKey] : [],
    ),
  );
});

/** Each separately asked batch's answers, in asking order. */
const valuesOfEach = <A>(results: readonly { readonly value: readonly A[] }[]) => results.flatMap(({ value }) => value);

/** Each separately asked batch's evidence rows, sorted as one measured read sorts its own. */
const rowsOfEach = (results: readonly { readonly decisionRowContents: readonly string[] }[]) =>
  results.flatMap(({ decisionRowContents }) => decisionRowContents).toSorted();

/** The first Action key of each of `modules`, in that order. */
const firstActionsOf = (keys: readonly string[], modules: readonly string[]) =>
  modules.flatMap((moduleKey) => keys.filter((key) => key.startsWith(`${moduleKey}.`)).slice(0, 1));

/** The first Action of each of `modules`, asked of the real gate in one batch by `person` in `legalEntityId`. */
const firstActionsAsked = (input: {
  readonly authorityCase: AuthorityCase;
  readonly correlationId: string;
  readonly legalEntityId: string;
  readonly modules: readonly string[];
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) =>
  measured({
    authorityCase: input.authorityCase,
    correlationId: input.correlationId,
    read: Effect.gen(function* askActions() {
      const actionKeys = firstActionsOf(yield* queueReadActionKeys, input.modules);
      const scope = yield* sessionScope({
        correlationId: input.correlationId,
        legalEntityId: input.legalEntityId,
        principalId: input.authorityCase.person,
        tenantId: input.authorityCase.tenantId,
      });
      return yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys, scope });
    }),
    snapshot: input.snapshot,
  });

/** The first work-tasks Action key: what one work-tasks proposal batch names. */
const firstTaskAction = (keys: readonly string[]) => keys.filter((key) => key.startsWith('work.tasks.')).slice(0, 1);

const sorted = (values: Iterable<string>) => [...values].toSorted();

/** The members of `modules` that are in `kept`, sorted. */
const keptIn = (kept: readonly string[], modules: ReadonlySet<string>) => sorted(kept.filter((id) => modules.has(id)));

const reportPath = Config.option(Config.String('CALLER_AUTHORITY_REPORT'));

/**
 * Bounds of a stage tenant's caller authority load: one engine snapshot each for the carriers, the LISTs and the
 * Actions, with one kind and scope read for all LISTs. Asking every composed module took 86 transactions; one LIST
 * call at a time, 36 and 6 snapshots; one call with a preamble per LIST, 30.
 */
const CALLER_INSTALLED_BOUNDS = { checkBulk: 3, transactions: 20 };

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '900 seconds' })(
  'agent platform caller authority over the installed release',
  (suite) => {
    suite.effect(
      "asks a tenant owner's caller authority and a queue read's Action authority in batches, with identical answers and evidence",
      () =>
        withAuthorityCase('work.tasks', (authorityCase) =>
          Effect.gen(function* batchedCallerAuthority() {
            const snapshot = yield* installedComposition;
            const { companyId, owner, tenantId } = authorityCase;
            const ownerScope = (correlationId: string) =>
              sessionScope({ correlationId, legalEntityId: companyId, principalId: owner, tenantId });

            // (a) one caller authority load.
            const trace = yield* Ref.make(emptyCallerAccessTrace);
            const callerScope = yield* ownerScope('caller-authority-batch');
            const caller = yield* measured({
              authorityCase,
              correlationId: 'caller-authority-batch',
              read: callerModuleAccess({ scope: callerScope }, trace),
              snapshot,
            });
            const callerBefore = yield* measured({
              authorityCase,
              correlationId: 'caller-authority-single',
              read: callerAccessOneAtATime(yield* ownerScope('caller-authority-single')),
              snapshot,
            });
            // Every module of the release is installed and active in this tenant, so the filter removes nothing here.
            expect(sorted(caller.value.access)).toEqual(sorted(callerBefore.value.access));
            expect(sorted(caller.value.propose)).toEqual(sorted(callerBefore.value.propose));
            expect(sorted(caller.value.write)).toEqual(sorted(callerBefore.value.write));
            expect(caller.decisionRows).toBeGreaterThan(0);
            expect(caller.decisionRows).toBe(callerBefore.decisionRows);
            expect(caller.decisionRowContents).toEqual(callerBefore.decisionRowContents);
            expect(caller.transactions).toBeLessThan(callerBefore.transactions);

            // (b) the Action authority one proposal queue read asks; a decide runs that read twice.
            const queueScope = yield* ownerScope('queue-authority-batch');
            const queue = yield* measured({
              authorityCase,
              correlationId: 'queue-authority-batch',
              read: Effect.gen(function* batchedQueueAuthority() {
                const actionKeys = yield* queueReadActionKeys;
                return yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys, scope: queueScope });
              }),
              snapshot,
            });
            const queueBefore = yield* measured({
              authorityCase,
              correlationId: 'queue-authority-single',
              read: Effect.gen(function* singleQueueAuthority() {
                return yield* actionsOneAtATime(
                  yield* queueReadActionKeys,
                  yield* ownerScope('queue-authority-single'),
                );
              }),
              snapshot,
            });
            expect(queue.value).toEqual(queueBefore.value);
            expect(queue.decisionRows).toBe(queueBefore.decisionRows);
            expect(queue.decisionRowContents).toEqual(queueBefore.decisionRowContents);
            expect(queue.transactions).toBeLessThan(queueBefore.transactions);

            const path = yield* reportPath;
            if (Option.isSome(path)) {
              const fileSystem = yield* FileSystem.FileSystem;
              yield* fileSystem.writeFileString(
                path.value,
                yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  caller: { after: reportOf(caller), before: reportOf(callerBefore) },
                  modules: snapshot.composition.modules.length,
                  queue: { after: reportOf(queue), before: reportOf(queueBefore) },
                  queueActions: queue.value.length,
                  trace: yield* Ref.get(trace),
                }),
              );
            }
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      900_000,
    );

    suite.effect(
      "asks a stage tenant owner's caller authority only about the modules the tenant installed",
      () =>
        withAuthorityCase('work.tasks', (authorityCase) =>
          Effect.gen(function* installedCallerAuthority() {
            const snapshot = yield* installedComposition;
            const { companyId, owner, tenantId } = authorityCase;
            // Stage's N1 demo tenant: 6 of the release's modules installed, the owner holding full access.
            const installed = [
              'commerce.customer-context',
              'commerce.market-catalog',
              'commerce.storefront-registry',
              'demo.merchandise',
              'party.registry',
              'work.tasks',
            ];
            yield* authorityCase.reinstall(installed);
            const ownerScope = (correlationId: string) =>
              sessionScope({ correlationId, legalEntityId: companyId, principalId: owner, tenantId });
            const trace = yield* Ref.make(emptyCallerAccessTrace);
            const caller = yield* measured({
              authorityCase,
              correlationId: 'installed-caller-authority',
              read: callerModuleAccess({ scope: yield* ownerScope('installed-caller-authority') }, trace),
              snapshot,
            });
            // Asking every composed module, as before, then dropping the uninstalled ones (all installed ones are
            // active, which admits reads and writes) gives the same rights.
            const everything = yield* measured({
              authorityCase,
              correlationId: 'installed-caller-reference',
              read: callerAccessOneAtATime(yield* ownerScope('installed-caller-reference')),
              snapshot,
            });
            expect(sorted(caller.value.access)).toEqual(keptIn(installed, everything.value.access));
            expect(sorted(caller.value.propose)).toEqual(keptIn(installed, everything.value.propose));
            expect(sorted(caller.value.write)).toEqual(keptIn(installed, everything.value.write));
            const remaining = [...everything.decisionRowContents];
            for (const row of caller.decisionRowContents) {
              const at = remaining.indexOf(row);
              expect(at).toBeGreaterThanOrEqual(0);
              remaining.splice(at, 1);
            }
            // One exact proposal batch read's Action authority: every Action of the release (as it asked before) or
            // only the one its rows name (a work-tasks proposal), as an approval's five batch reads now ask it.
            const batchScope = yield* ownerScope('installed-batch-authority');
            const everyAction = yield* measured({
              authorityCase,
              correlationId: 'installed-batch-every-action',
              read: Effect.gen(function* everyActionAuthority() {
                const actionKeys = yield* queueReadActionKeys;
                return yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys, scope: batchScope });
              }),
              snapshot,
            });
            const oneAction = yield* measured({
              authorityCase,
              correlationId: 'installed-batch-one-action',
              read: Effect.gen(function* oneActionAuthority() {
                const actionKeys = firstTaskAction(yield* queueReadActionKeys);
                return yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys, scope: batchScope });
              }),
              snapshot,
            });
            const [taskAction] = oneAction.value;
            expect(oneAction.value).toEqual(
              everyAction.value.filter(({ actionKey }) => actionKey === taskAction?.actionKey),
            );
            expect(oneAction.counters.checkItems).toBeLessThan(everyAction.counters.checkItems);
            const path = yield* reportPath;
            if (Option.isSome(path)) {
              yield* (yield* FileSystem.FileSystem).writeFileString(
                `${path.value}.installed.json`,
                yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  after: reportOf(caller),
                  batchAuthorityEvery: reportOf(everyAction),
                  batchAuthorityOne: reportOf(oneAction),
                  everything: reportOf(everything),
                  trace: yield* Ref.get(trace),
                }),
              );
            }
            // Asking every composed module: 16 SpiceDB calls (14 of them one LIST each) and 478 evidence rows.
            expect(caller.counters.checkBulk).toBeLessThanOrEqual(CALLER_INSTALLED_BOUNDS.checkBulk);
            expect(caller.transactions).toBeLessThanOrEqual(CALLER_INSTALLED_BOUNDS.transactions);
            expect(caller.decisionRows).toBeLessThan(everything.decisionRows);
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      300_000,
    );

    suite.effect(
      'gives every Action the same allow/deny answer through the real gate batch as when asked alone, with the same rows',
      () =>
        withAuthorityCase('work.tasks', (authorityCase) =>
          Effect.gen(function* independentAnswers() {
            const snapshot = yield* installedComposition;
            const { companyId, otherCompanyId } = authorityCase;
            yield* authorityCase.reinstall([
              'commerce.customer-context',
              'commerce.market-catalog',
              'commerce.storefront-registry',
              'demo.merchandise',
              'party.registry',
              'work.tasks',
            ]);
            // Granted in this company but its module is not installed (never projected), and granted only in the other.
            yield* authorityCase.grant('facility.operations', companyId);
            yield* authorityCase.grant('party.registry', otherCompanyId);
            const askIn = (legalEntityId: string, correlationId: string, modules: readonly string[]) =>
              firstActionsAsked({ authorityCase, correlationId, legalEntityId, modules, snapshot });
            const modules = ['work.tasks', 'facility.operations', 'party.registry'];
            const together = yield* askIn(companyId, 'independent-together', modules);
            const alone = yield* Effect.forEach(
              modules,
              (moduleKey) => askIn(companyId, `independent-${moduleKey}`, [moduleKey]),
              { concurrency: 1 },
            );
            expect(together.value).toEqual(valuesOfEach(alone));
            expect(together.value.map(({ execute }) => execute)).toEqual(['allowed', 'denied', 'denied']);
            // The same evidence rows, row for row: each denial is recorded whatever was asked beside it.
            expect(together.decisionRowContents).toEqual(rowsOfEach(alone));
            expect(together.decisionRowContents.filter((row) => row.includes('|DENIED|'))).toHaveLength(2);
            // The other company's grant is real: there the same Action runs.
            const elsewhere = yield* askIn(otherCompanyId, 'independent-elsewhere', ['party.registry']);
            expect(elsewhere.value.map(({ execute }) => execute)).toEqual(['allowed']);
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      300_000,
    );
  },
);
