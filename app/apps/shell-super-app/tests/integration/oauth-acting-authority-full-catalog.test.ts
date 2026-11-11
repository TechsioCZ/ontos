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
import {
  SubjectAccessInspection,
  SubjectAccessInspectionLive,
  SubjectInspectionIdentitySourceLive,
} from '@app/core-runtime/access/enforcement';
import type { SubjectInspectionInput } from '@app/core-runtime/access/enforcement';
import {
  AccessDecisionLogBatchLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import type { PgClient } from '@effect/sql-pg';
import { Config, Crypto, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Tracer } from 'effect';
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
import { emptySubjectAccessTrace, moduleCarriers, subjectModuleAccess } from '../../api/agent-platform/caller.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
  ShellInstalledModuleCatalogLive,
} from '../../api/modules/installed-module-catalog.ts';
import { loadActingAuthority } from '../../api/oauth-connections/connection-service.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  buildAccessGraph,
  replacedDatabase,
  templateDatabaseLayer,
} from '../support/access-admin-real-gate-fixture.ts';

/*
 * The consent page's one slow step, measured against the real stack: `loadActingAuthority` for one signed-in
 * person in one company, over the composition of every module the release installs (derived from the repository's
 * own vertical manifests), the real subject inspection, the real intent loader under the Shell's runtime database
 * role and the integration SpiceDB. Round trips are counted from the runtime's own spans, never timed.
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

/** The Shell's inspection composition over this case's runtime database role, SpiceDB and the installed release. */
const inspectionLayer = (input: {
  readonly authorityCase: AuthorityCase;
  readonly counters: Counters;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) =>
  Layer.unwrap(
    Effect.gen(function* buildInspection() {
      const database = yield* makeCoreDatabase(input.authorityCase.runtime);
      const configuration = yield* loadSpiceDbConfig();
      const rpc = yield* Effect.acquireRelease(
        Effect.sync(() => spiceDbTransport.open(configuration, SPICEDB_CHECK_TIMEOUT_MS)),
        (opened) => Effect.sync(() => opened.close()),
      );
      // The production composition path: the source hands out the encoded active snapshot (on stage, the 30-second
      // cached authority read) and `ActiveApplicationCompositionConfigLive` decodes, validates and leases it.
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
        AccessDecisionLogBatchLive,
        AccessPrincipalKindSourceLive,
        SubjectInspectionIdentitySourceLive,
        Layer.succeed(DecisionCheck, countedCheck(enginePortOf(rpc), input.counters)),
        composition,
      ).pipe(Layer.provideMerge(base));
      return Layer.mergeAll(
        SubjectAccessInspectionLive.pipe(Layer.provide(ports)),
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
  /** Every company of the tenant, `companyId` first; the owner is bootstrapped into all of them. */
  readonly companyIds: readonly string[];
  readonly owner: string;
  readonly person: string;
  readonly runtime: DatabaseConnectionPair['runtime'];
  readonly tenantId: string;
}

/**
 * One cloned database with one tenant, one company, its bootstrapped owner and one person who holds a role with every
 * `run` capability of `moduleId` in that company, projected into SpiceDB by the one Core writer.
 */
const withAuthorityCase = <A, E>(
  moduleId: string,
  run: (authorityCase: AuthorityCase) => Effect.Effect<A, E>,
  companies = 1,
  /** The one mode the person's role grants: `propose` makes an approval-only subject of the module. */
  cellMode: 'propose' | 'run' = 'run',
) =>
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
      const companyIds = yield* Effect.forEach(Array.from({ length: companies }), () => crypto.randomUUIDv4());
      const [companyId = ''] = companyIds;
      const owner = yield* crypto.randomUUIDv4();
      const person = yield* crypto.randomUUIDv4();
      yield* admin.unsafe(
        `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ('${tenantId}', 'acting-${tenantId.slice(0, 8)}', 'Acting authority tenant', 'active', 'cs')`,
      );
      for (const legalEntityId of companyIds) {
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
        legalEntityIds: companyIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)),
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
      const companyScopeId = scopeIds.find(
        ({ legal_entity_id: legalEntityId }) => legalEntityId === companyId,
      )?.scope_id;
      const cells = catalog
        .flatMap(({ descriptors }) => descriptors.map(({ accessDeclaration }) => accessDeclaration))
        .flatMap((declaration) =>
          declaration !== undefined &&
          declaration.key.startsWith(`${moduleId}.`) &&
          declaration.modes.includes(cellMode)
            ? [{ capabilityKey: declaration.key, mode: cellMode, selector: { _tag: 'all' } }]
            : [],
        );
      const roleId = yield* crypto.randomUUIDv4();
      const roleRevisionId = yield* crypto.randomUUIDv4();
      yield* admin.unsafe(
        `insert into core.access_roles (role_id, tenant_id, created_by, name)
         values ('${roleId}', '${tenantId}', '${owner}', 'Module ${moduleId}')`,
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
           values (gen_random_uuid(), '${tenantId}', '${companyScopeId}', '${roleId}', '${cell.capabilityKey}',
                   '${cell.mode}', 'all', '${jsonText(cell)}'::jsonb, 'active')`,
        );
      }
      yield* admin.unsafe(
        `insert into core.access_assignments
           (incarnation_id, tenant_id, scope_id, principal_id, role_id, role_revision_id, status, assigned_by, valid_from)
         values (gen_random_uuid(), '${tenantId}', '${companyScopeId}', '${person}', '${roleId}',
                 '${roleRevisionId}', 'active', '${owner}', now() - interval '1 day')`,
      );
      yield* graph.writer.reconcileTenant({ scope: ownerScope });
      return yield* run({ admin, companyId, companyIds, owner, person, runtime: databases.runtime, tenantId });
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
    // Process CPU time of the read (user + system): the suite runs one read at a time, so it is the read's own.
    const cpuBefore = process.cpuUsage();
    const value = yield* input.read.pipe(
      Effect.withSpan('measured.read'),
      Effect.withTracer(recordingTracer(records)),
      Effect.provide(inspectionLayer({ authorityCase: input.authorityCase, counters, snapshot: input.snapshot })),
    );
    const cpu = process.cpuUsage(cpuBefore);
    const [rows] = yield* input.authorityCase.admin.unsafe<{ readonly count: number }>(
      `select count(*)::int as count from core.access_decision_logs where correlation_id = '${input.correlationId}'`,
    );
    const spans = tally(records);
    return {
      cellBatches: countOf(spans, 'TenantIntentLoader.loadAuthorityCellsMany'),
      cellReads: countOf(spans, 'TenantIntentLoader.loadAuthorityCells'),
      counters,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
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
  cellBatches: result.cellBatches,
  cellReads: result.cellReads,
  counters: result.counters,
  cpuMs: result.cpuMs,
  decisionRows: result.decisionRows,
  ms: result.ms,
  slowest: [...result.spans.entries()]
    .toSorted(([, left], [, right]) => right.ms - left.ms)
    .slice(0, 25)
    .map(([name, { count, ms }]) => ({ count, ms: Math.round(ms), name })),
  statements: result.statements,
  transactions: result.transactions,
});

/**
 * The same questions asked one at a time through the single `inspect`/`list` calls, two at a time — what the Shell
 * did before it asked them in one batch — so the batch's answers and evidence rows can be compared with it.
 */
const oneQuestionAtATime = (input: SubjectInspectionInput) =>
  Effect.gen(function* askOneAtATime() {
    const inspection = yield* SubjectAccessInspection;
    const installed = yield* (yield* ShellInstalledModuleCatalog).load;
    yield* inspection.scope(input);
    const access = new Set<string>();
    yield* Effect.forEach(
      moduleCarriers(installed),
      (carrier) => {
        const question = {
          ...input,
          carrier: { accessDeclaration: carrier.declaration },
          legalEntityScope: carrier.legalEntityScope,
        };
        const asked =
          carrier.declaration?.kind === 'read' && carrier.declaration.selectors.length > 0
            ? inspection.list(question)
            : inspection.inspect(question);
        return asked.pipe(
          Effect.map(({ decision }) =>
            decision.outcome === 'ALLOWED' || decision.outcome === 'NEEDS_APPROVAL'
              ? access.add(carrier.moduleId)
              : access,
          ),
        );
      },
      { concurrency: 2, discard: true },
    );
    const actions = installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
    );
    const owners = new Map(actions.map(({ actionKey, owningModuleId }) => [actionKey, owningModuleId]));
    const run = new Set<string>();
    const authorities = yield* Effect.forEach(
      [...owners.keys()],
      (actionKey) => inspection.actions({ ...input, actionKeys: [actionKey] }),
      { concurrency: 2 },
    );
    for (const { authorities: [authority] = [] } of authorities) {
      const owner = authority === undefined ? undefined : owners.get(authority.actionKey);
      if (owner !== undefined && (authority?.run === 'allowed' || authority?.propose === 'allowed')) {
        access.add(owner);
      }
      if (owner !== undefined && authority?.run === 'allowed') {
        run.add(owner);
      }
    }
    return { access: [...access], run: [...run] };
  });

/**
 * The module hints as they were asked before the hints stopped at the first admitted question: every carrier and
 * every Action in one batch. The reference the two-phase `subjectModuleAccess` must equal set for set.
 */
const everythingAtOnce = (input: SubjectInspectionInput) =>
  Effect.gen(function* askEverything() {
    const inspection = yield* SubjectAccessInspection;
    const installed = yield* (yield* ShellInstalledModuleCatalog).load;
    yield* inspection.scope(input);
    const carriers = moduleCarriers(installed);
    const actions = installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
    );
    const actionKeys = [...new Set(actions.map(({ actionKey }) => actionKey))];
    const inspected = yield* inspection.capabilities({
      ...input,
      actionKeys,
      questions: carriers.map((carrier) => ({
        carrier: { accessDeclaration: carrier.declaration },
        legalEntityScope: carrier.legalEntityScope,
        listing: carrier.declaration?.kind === 'read' && carrier.declaration.selectors.length > 0,
      })),
    });
    const access = new Set<string>();
    const propose = new Set<string>();
    const run = new Set<string>();
    for (const [index, carrier] of carriers.entries()) {
      const outcome = inspected.answers[index]?.decision.outcome;
      if (outcome === 'ALLOWED' || outcome === 'NEEDS_APPROVAL') {
        access.add(carrier.moduleId);
      }
    }
    const byKey = new Map(inspected.authorities.map((authority) => [authority.actionKey, authority]));
    for (const action of actions) {
      const authority = byKey.get(action.actionKey);
      if (authority?.run === 'allowed') {
        run.add(action.owningModuleId);
        access.add(action.owningModuleId);
      }
      if (authority?.propose === 'allowed') {
        propose.add(action.owningModuleId);
        access.add(action.owningModuleId);
      }
    }
    return { access, propose, run };
  });

const sortedSet = (values: ReadonlySet<string>) => [...values].toSorted();

/** The two-phase hints equal the everything-at-once reference and leave no more evidence rows than it does. */
const expectSameHints = (input: {
  readonly authorityCase: AuthorityCase;
  readonly principalId: string;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) =>
  Effect.gen(function* sameHints() {
    const { companyId, tenantId } = input.authorityCase;
    const inspectionOf = (correlationId: string) =>
      sessionScope({ correlationId, legalEntityId: companyId, principalId: input.principalId, tenantId }).pipe(
        Effect.map((requesterScope): SubjectInspectionInput => ({
          queryScope: { legalEntityId: companyId, tenantId },
          requesterScope,
          subject: { principalId: input.principalId, tenantId },
        })),
      );
    const hints = yield* measured({
      authorityCase: input.authorityCase,
      correlationId: `hints-${input.principalId}`,
      read: subjectModuleAccess(yield* inspectionOf(`hints-${input.principalId}`)),
      snapshot: input.snapshot,
    });
    const reference = yield* measured({
      authorityCase: input.authorityCase,
      correlationId: `reference-${input.principalId}`,
      read: everythingAtOnce(yield* inspectionOf(`reference-${input.principalId}`)),
      snapshot: input.snapshot,
    });
    expect(sortedSet(hints.value.access)).toEqual(sortedSet(reference.value.access));
    expect(sortedSet(hints.value.run)).toEqual(sortedSet(reference.value.run));
    expect(sortedSet(hints.value.propose)).toEqual(sortedSet(reference.value.propose));
    expect(hints.decisionRows).toBeLessThanOrEqual(reference.decisionRows);
    return { hints, reference };
  });

const reportPath = Config.option(Config.String('ACTING_AUTHORITY_REPORT'));
const ownerReportPath = Config.option(Config.String('OWNER_AUTHORITY_REPORT'));

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'acting authority over the installed release',
  (suite) => {
    suite.effect(
      "loads one person's authority over every installed module in a bounded number of round trips",
      () =>
        withAuthorityCase('work.tasks', (authorityCase) =>
          Effect.gen(function* boundedAuthority() {
            const snapshot = yield* installedComposition;
            const { companyId, person, tenantId } = authorityCase;
            const asker = yield* sessionScope({
              correlationId: 'acting-authority-batch',
              legalEntityId: companyId,
              principalId: person,
              tenantId,
            });
            const trace = yield* Ref.make(emptySubjectAccessTrace);
            const batch = yield* measured({
              authorityCase,
              correlationId: 'acting-authority-batch',
              read: loadActingAuthority(
                asker,
                { actingKind: 'human', actingPrincipalId: person, legalEntityId: companyId, tenantId },
                trace,
              ),
              snapshot,
            });
            const traced = yield* Ref.get(trace);
            // The person holds one role over the tasks module: exactly that module, readable and writable.
            expect([...batch.value.live.read]).toEqual(['work.tasks']);
            expect([...batch.value.live.write]).toEqual(['work.tasks']);
            expect(batch.value.offered.map(({ moduleId }) => moduleId)).toEqual(['work.tasks']);
            expect(batch.value.policyCap).toBe('direct');

            // Round trips, counted: two inspection calls, a fixed number of identity, scope, engine, composition
            // and evidence round trips, and one intent read per distinct capability the release declares.
            const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
            const carriers = moduleCarriers(installed);
            const listCarriers = carriers.filter(
              ({ declaration }) => declaration?.kind === 'read' && declaration.selectors.length > 0,
            ).length;
            const capabilityKeys = new Set(carriers.flatMap(({ declaration }) => declaration?.key ?? []));
            expect(snapshot.composition.modules.length).toBeGreaterThan(20);
            // Only the carriers of modules no Action admitted are asked, in at most two capability batches.
            expect(traced.carriers).toBeLessThanOrEqual(carriers.length);
            expect(traced.inspectionCalls).toBeLessThanOrEqual(3);
            expect(batch.counters.compositionLoads).toBeLessThanOrEqual(9);
            expect(batch.counters.checkBulk).toBeLessThanOrEqual(2 + listCarriers);
            expect(batch.transactions - batch.cellReads).toBeLessThanOrEqual(24);
            // Every cell set of a capability batch is read in ONE transaction; only a LIST question reads its own.
            expect(batch.cellBatches).toBeLessThanOrEqual(2);
            expect(batch.cellReads).toBeLessThanOrEqual(listCarriers);
            expect(capabilityKeys.size).toBeGreaterThan(100);

            // The same questions one at a time, as the Shell asked them before: identical modules, identical
            // evidence rows, and the round trips the batch no longer makes.
            const single = yield* measured({
              authorityCase,
              correlationId: 'acting-authority-single',
              read: oneQuestionAtATime({
                queryScope: { legalEntityId: companyId, tenantId },
                requesterScope: yield* sessionScope({
                  correlationId: 'acting-authority-single',
                  legalEntityId: companyId,
                  principalId: person,
                  tenantId,
                }),
                subject: { principalId: person, tenantId },
              }),
              snapshot,
            });
            expect(single.value.access).toEqual([...batch.value.live.read]);
            expect(batch.decisionRows).toBeGreaterThan(0);
            expect(batch.decisionRows).toBeLessThanOrEqual(single.decisionRows);
            yield* expectSameHints({ authorityCase, principalId: person, snapshot });
            expect(batch.transactions * 4).toBeLessThan(single.transactions);

            const path = yield* reportPath;
            if (Option.isSome(path)) {
              const fileSystem = yield* FileSystem.FileSystem;
              yield* fileSystem.writeFileString(
                path.value,
                yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  batch: reportOf(batch),
                  carriers: carriers.length,
                  listCarriers,
                  modules: snapshot.composition.modules.length,
                  single: reportOf(single),
                  trace: traced,
                }),
              );
            }
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      300_000,
    );

    // Every MCP request re-describes its connection live (`loadLiveConnection` -> `loadActingAuthority`). For the
    // tenant owner, who holds every right of the release in each of several companies, that description must cost
    // a fixed number of round trips, never one intent read per capability the catalog declares.
    suite.effect(
      "describes a full-access owner's connection authority in a fixed number of round trips",
      () =>
        withAuthorityCase(
          'work.tasks',
          (authorityCase) =>
            Effect.gen(function* ownerAuthority() {
              const snapshot = yield* installedComposition;
              const { companyId, companyIds, owner, tenantId } = authorityCase;
              const asker = yield* sessionScope({
                correlationId: 'owner-authority-batch',
                legalEntityId: companyId,
                principalId: owner,
                tenantId,
              });
              const trace = yield* Ref.make(emptySubjectAccessTrace);
              const owned = yield* measured({
                authorityCase,
                correlationId: 'owner-authority-batch',
                read: loadActingAuthority(
                  asker,
                  { actingKind: 'human', actingPrincipalId: owner, legalEntityId: companyId, tenantId },
                  trace,
                ),
                snapshot,
              });
              const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
              const carriers = moduleCarriers(installed);
              const listCarriers = carriers.filter(
                ({ declaration }) => declaration?.kind === 'read' && declaration.selectors.length > 0,
              ).length;
              expect(companyIds.length).toBe(3);
              // The owner reaches every module the tenant runs.
              expect(owned.value.live.read.size).toBeGreaterThan(20);
              expect(owned.value.offered.length).toBe(owned.value.live.read.size);
              expect((yield* Ref.get(trace)).inspectionCalls).toBeLessThanOrEqual(3);
              const { reference } = yield* expectSameHints({ authorityCase, principalId: owner, snapshot });
              expect(owned.counters.checkBulk).toBeLessThanOrEqual(2 + listCarriers);
              // The work does not grow with the rights the catalog declares (hundreds): one batched cell read, one
              // read per LIST question, a fixed number of identity, scope and evidence transactions. Before the batch,
              // this owner cost one transaction per capability and mode: 463 transactions, 3 252 statements.
              expect(owned.cellBatches).toBeLessThanOrEqual(2);
              expect(owned.cellReads).toBeLessThanOrEqual(listCarriers);
              expect(owned.transactions - owned.cellReads).toBeLessThanOrEqual(24);
              expect(owned.statements).toBeLessThanOrEqual(300);

              const path = yield* ownerReportPath;
              if (Option.isSome(path)) {
                const fileSystem = yield* FileSystem.FileSystem;
                yield* fileSystem.writeFileString(
                  path.value,
                  yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    carriers: carriers.length,
                    companies: companyIds.length,
                    listCarriers,
                    modules: snapshot.composition.modules.length,
                    owner: reportOf(owned),
                    read: owned.value.live.read.size,
                    reference: reportOf(reference),
                  }),
                );
              }
            }).pipe(Effect.provide(NodeServices.layer)),
          3,
        ),
      300_000,
    );

    // An approval-only subject: the role grants only `propose` over one module. The hints must find the module
    // proposable but not runnable, exactly as asking everything does, so the connection's ceiling stays approval.
    suite.effect(
      'describes a propose-only person exactly as asking every carrier and Action at once',
      () =>
        withAuthorityCase(
          'commerce.pricing',
          (authorityCase) =>
            Effect.gen(function* proposeOnlyHints() {
              const snapshot = yield* installedComposition;
              const { hints } = yield* expectSameHints({
                authorityCase,
                principalId: authorityCase.person,
                snapshot,
              });
              expect([...hints.value.propose]).toContain('commerce.pricing');
              expect([...hints.value.run]).not.toContain('commerce.pricing');
            }).pipe(Effect.provide(NodeServices.layer)),
          1,
          'propose',
        ),
      300_000,
    );
  },
);
