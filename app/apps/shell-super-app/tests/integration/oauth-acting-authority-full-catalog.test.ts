import { v1 } from '@authzed/authzed-node';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionSnapshotSchema,
  decideModuleStateAccess,
  loadDatabaseConnectionPair,
  makeDatabaseIdentityEnrollmentLive,
  OAuthConnectionCompaniesLive,
  OntosDeploymentAppIdSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  parseDatabaseConnectionPair,
  TenantModuleStateService,
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
import { Config, Crypto, DateTime, Effect, FileSystem, Layer, Match, Option, Path, Ref, Schema, Tracer } from 'effect';
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
import { timedDescription } from '../../api/mcp/describe-timing.ts';
import { describeLiveGrant, loadActingAuthority } from '../../api/oauth-connections/connection-service.ts';
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
  /** The names of the span's ancestors, nearest first (test diagnostics only). */
  readonly parents: readonly string[];
  /** Start instant in milliseconds, process-relative; only differences between records are meaningful. */
  readonly startMs: number;
}

/** The named ancestors of a span, nearest first, at most eight. */
const ancestorsOf = (parent: Option.Option<Tracer.AnySpan>, names: readonly string[] = []): readonly string[] =>
  Option.isNone(parent) || names.length >= 8
    ? names
    : Match.value(parent.value).pipe(
        Match.tag('Span', (span) => ancestorsOf(span.parent, [...names, span.name])),
        Match.tag('ExternalSpan', () => names),
        Match.exhaustive,
      );

/** A tracer that keeps every finished span's name and duration; database and engine calls are spans of their own. */
const recordingTracer = (records: SpanRecord[]) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        records.push({
          ms: Number(endTime - options.startTime) / 1e6,
          name: options.name,
          parents: ancestorsOf(options.parent),
          startMs: Number(options.startTime) / 1e6,
        });
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
      return port.checkBulk(items).pipe(Effect.withSpan('spicedb.checkBulk'));
    }),
});

/** `staged` answered by the plain scope and capability calls, each resolving the subject and writing on its own. */
const unsharedStages = Layer.effect(
  SubjectAccessInspection,
  Effect.gen(function* unsharedInspection() {
    const service = yield* SubjectAccessInspection;
    return {
      ...service,
      // The plain calls; only the verified revision is taken from a staged inspection.
      staged: (input, body) =>
        service.staged(input, ({ revision }) =>
          body({
            capabilities: (asked) => service.capabilities({ ...input, ...asked }),
            prepare: () => Effect.void,
            revision,
            scope: service.scope(input),
          }),
        ),
    };
  }),
);

/** The Shell's inspection composition over this case's runtime database role, SpiceDB and the installed release. */
const inspectionLayer = (input: {
  readonly authorityCase: AuthorityCase;
  readonly counters: Counters;
  /** The published stages without sharing: `staged` answered by the plain calls (the equivalence reference). */
  readonly plainStages?: boolean;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) =>
  Layer.unwrap(
    Effect.gen(function* buildInspection() {
      const configuration = yield* loadSpiceDbConfig();
      const database = yield* makeCoreDatabase(input.authorityCase.runtime);
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
      const inspection = SubjectAccessInspectionLive.pipe(Layer.provide(ports));
      return Layer.mergeAll(
        input.plainStages === true ? unsharedStages.pipe(Layer.provide(inspection)) : inspection,
        ShellInstalledModuleCatalogLive.pipe(Layer.provide(composition)),
        TenantModuleStateServiceLive.pipe(Layer.provide(base)),
        OAuthConnectionCompaniesLive.pipe(Layer.provide(base)),
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
  /**
   * Leaves exactly these modules installed for the tenant and reprojects its graph through the Core writer; with
   * `project: false` the states change but the projection does not follow yet.
   */
  readonly reinstall: (moduleKeys: readonly string[], options?: { readonly project?: boolean }) => Effect.Effect<void>;
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
      const reinstall = (moduleKeys: readonly string[], options?: { readonly project?: boolean }) =>
        Effect.gen(function* reinstallModules() {
          yield* admin.unsafe(`delete from core.tenant_module_states where tenant_id = '${tenantId}'`);
          for (const moduleKey of moduleKeys) {
            yield* admin.unsafe(
              `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state)
               values (gen_random_uuid(), '${tenantId}', '${moduleKey}', 'active')`,
            );
          }
          if (options?.project !== false) {
            yield* graph.writer.reconcileTenant({ scope: ownerScope });
          }
        }).pipe(Effect.orDie);
      return yield* run({
        admin,
        companyId,
        companyIds,
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
  readonly plainStages?: boolean;
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
      Effect.provide(
        inspectionLayer({
          authorityCase: input.authorityCase,
          counters,
          plainStages: input.plainStages === true,
          snapshot: input.snapshot,
        }),
      ),
    );
    const cpu = process.cpuUsage(cpuBefore);
    const [rows] = yield* input.authorityCase.admin.unsafe<{ readonly count: number }>(
      `select count(*)::int as count from core.access_decision_logs where correlation_id = '${input.correlationId}'`,
    );
    // Every row's content: all columns except its own id, the correlation it was tagged with and its instant.
    const contents = yield* input.authorityCase.admin.unsafe<{ readonly content: string }>(
      `select concat_ws('|', actor_principal_id, actor_json::text, capability_key, mode, outcome, reasons_json::text,
                        scope_id, coalesce(target::text, '-'), tenant_id, coalesce(admission_deadline::text, '-'),
                        coalesce(delegate_app_id::text, '-'), coalesce(delegate_principal_id::text, '-'),
                        coalesce(on_behalf_of_principal_id::text, '-'), coalesce(operation_id::text, '-')) as content
         from core.access_decision_logs where correlation_id = '${input.correlationId}' order by content`,
    );
    const spans = tally(records);
    return {
      cellBatches: countOf(spans, 'TenantIntentLoader.loadAuthorityCellsMany'),
      cellReads: countOf(spans, 'TenantIntentLoader.loadAuthorityCells'),
      counters,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      decisionRowContents: contents.map(({ content }) => content),
      decisionRows: rows?.count ?? -1,
      // Wall time of the read itself, from the span the recording tracer closed around it.
      ms: Math.round(spans.get('measured.read')?.ms ?? -1),
      records,
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
    // The staged description against the same stages asked one call at a time (no shared resolution, each batch
    // writing before it answers): the same hints, and the same evidence rows, row for row.
    const unshared = yield* measured({
      authorityCase: input.authorityCase,
      correlationId: `unshared-${input.principalId}`,
      plainStages: true,
      read: subjectModuleAccess(yield* inspectionOf(`unshared-${input.principalId}`)),
      snapshot: input.snapshot,
    });
    expect(sortedSet(hints.value.access)).toEqual(sortedSet(unshared.value.access));
    expect(sortedSet(hints.value.run)).toEqual(sortedSet(unshared.value.run));
    expect(sortedSet(hints.value.propose)).toEqual(sortedSet(unshared.value.propose));
    expect(hints.decisionRows).toBe(unshared.decisionRows);
    expect(hints.decisionRowContents).toEqual(unshared.decisionRowContents);
    return { hints, reference };
  });

/**
 * The owner's connection description, counted by the product's own round-trip counter (`timedDescription`, the
 * counts the `mcp.request` and `agent-platform.request` lines carry) as well as by this suite's recording tracer.
 */
const countedOwnerDescription = Effect.fn('test.countedOwnerDescription')(function* countedOwnerDescription(input: {
  readonly authorityCase: AuthorityCase;
  readonly label: string;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) {
  const { companyId, owner, tenantId } = input.authorityCase;
  const correlationId = `owner-round-trips-${input.label}`;
  const asker = yield* sessionScope({ correlationId, legalEntityId: companyId, principalId: owner, tenantId });
  return yield* measured({
    authorityCase: input.authorityCase,
    correlationId,
    read: timedDescription(
      loadActingAuthority(asker, {
        actingKind: 'human',
        actingPrincipalId: owner,
        legalEntityId: companyId,
        tenantId,
      }),
    ),
    snapshot: input.snapshot,
  });
});

/** What one MCP request times: the live grant's description and the installed catalogue (`describeConnection`). */
const describeConnectionOf = (input: {
  readonly authorityCase: AuthorityCase;
  readonly correlationId: string;
  readonly principalId: string;
}) =>
  Effect.gen(function* describeConnectionOfCase() {
    const { companyId, tenantId } = input.authorityCase;
    const requesterScope = yield* sessionScope({
      correlationId: input.correlationId,
      legalEntityId: companyId,
      principalId: input.principalId,
      tenantId,
    });
    const at = yield* DateTime.nowAsDate;
    const live = yield* describeLiveGrant({
      grant: {
        actingKind: 'human',
        actingPrincipalId: input.principalId,
        authBindingId: null,
        clientHost: 'localhost',
        clientId: 'stage-shape-client',
        clientKind: 'loopback',
        clientLogoUri: null,
        clientName: 'Stage shape',
        consentedAt: at,
        consentId: null,
        createdAt: at,
        grantId: input.correlationId,
        lastUsedAt: null,
        legalEntityId: companyId,
        modules: 'all',
        profileId: input.correlationId,
        revokedAt: null,
        revokedByPrincipalId: null,
        revokeReason: null,
        sessionId: null,
        status: 'active',
        tenantId,
        userId: input.principalId,
        userPrincipalId: input.principalId,
        writePolicy: 'approval',
      },
      names: new Map(),
      requesterScope,
    });
    const installed = yield* (yield* ShellInstalledModuleCatalog).load;
    return { installed, live };
  });

/** The phase a round trip belongs to: the innermost of these spans around it (or a capability batch by time). */
const PHASE_SPANS = [
  'AccessDecision.list',
  'AccessDecisionLog.recordAll',
  'SubjectInspection.scope',
  'SubjectInspection.prepare',
  'SubjectInspection.current',
  'OAuthConnectionCompanies.names',
  'AgentPlatform.subjectCapabilityBatch',
] as const;

const PHASE_SPAN_NAMES = new Set<string>(PHASE_SPANS);

/** The round trips counted per phase, by the span that records each. */
const ROUND_TRIP_KIND = new Map<string, 'spicedb' | 'statements' | 'transactions'>([
  ['AccessDecision.spicedbCheckBulk', 'spicedb'],
  ['postgres', 'statements'],
  ['sql.transaction', 'transactions'],
]);

/** The capability key of one evidence row's content (`decisionRowContents`). */
const keyOfRow = (row: string) => row.split('|')[2] ?? '';

/** Each capability key's owning module, from the published catalogue. */
const owningModules = (catalog: Effect.Success<typeof publishedCatalog>) =>
  new Map<string, string>(
    catalog.flatMap(({ descriptors, moduleId }) =>
      descriptors.flatMap(({ accessDeclaration }) =>
        accessDeclaration === undefined ? [] : [[accessDeclaration.key, moduleId] as const],
      ),
    ),
  );

const phaseBreakdown = (records: readonly SpanRecord[]) => {
  const batches = records
    .filter(({ name }) => name === 'AgentPlatform.subjectCapabilityBatch')
    .toSorted((left, right) => left.startMs - right.startMs);
  const batchOf = (startMs: number) =>
    batches.findIndex((batch) => startMs >= batch.startMs && startMs <= batch.startMs + batch.ms) + 1;
  const phases = new Map<string, { spicedb: number; statements: number; transactions: number }>();
  for (const record of records) {
    const kind = ROUND_TRIP_KIND.get(record.name);
    if (kind === undefined) {
      continue;
    }
    const nearest = record.parents.find((name) => PHASE_SPAN_NAMES.has(name)) ?? 'other';
    const phase = nearest === 'AgentPlatform.subjectCapabilityBatch' ? `batch ${batchOf(record.startMs)}` : nearest;
    const entry = phases.get(phase) ?? { spicedb: 0, statements: 0, transactions: 0 };
    entry[kind] += 1;
    phases.set(phase, entry);
  }
  return Object.fromEntries([...phases].toSorted(([left], [right]) => left.localeCompare(right)));
};

/**
 * The connection's acting authority as it was computed before the questions were narrowed to installed modules:
 * every composed module asked, then everything outside the tenant's module states dropped.
 */
const referenceActingAuthority = (input: SubjectInspectionInput) =>
  Effect.gen(function* referenceAuthority() {
    const sets = yield* subjectModuleAccess(input);
    const answered = [...new Set([...sets.access, ...sets.run, ...sets.propose])];
    const states = yield* (yield* TenantModuleStateService).getTenantModuleStates(input.subject.tenantId, answered);
    const stateOf = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
    const admitted = (modules: ReadonlySet<string>, access: 'read' | 'write') =>
      [...modules].filter((moduleId) => decideModuleStateAccess(stateOf.get(moduleId) ?? null, access) === 'allow');
    const run = admitted(sets.run, 'write');
    const propose = admitted(sets.propose, 'write');
    return {
      policyCap: propose.some((moduleId) => !run.includes(moduleId)) ? 'approval' : 'direct',
      read: new Set(admitted(sets.access, 'read')),
      write: new Set([...run, ...propose]),
    };
  });

const descriptionReportPath = Config.option(Config.String('STAGE_SHAPE_REPORT'));

/** The modules stage's N1 demo tenant installs that the release composes (it installs one more it does not). */
const N1_MODULES = [
  'commerce.customer-context',
  'commerce.market-catalog',
  'commerce.storefront-registry',
  'demo.merchandise',
  'party.registry',
  'work.tasks',
];

/** A main demo tenant's 21 installed modules: every module the release composes but the five demo verticals. */
const MAIN_DEMO_MODULES = [
  'commerce.assortment',
  'commerce.catalog',
  'commerce.customer-context',
  'commerce.inventory',
  'commerce.market-catalog',
  'commerce.pricing',
  'commerce.storefront-registry',
  'commerce.tax',
  'crm.activities',
  'demo.merchandise',
  'facility.operations',
  'finance.billing',
  'legal.agreements',
  'party.registry',
  'payment.term-catalog',
  'pricing.price-group-catalog',
  'privacy.core',
  'projects.core',
  'property.leasing',
  'property.portfolio',
  'work.tasks',
];

/**
 * Every scoped transaction first reads its connected role (`select current_user`, main's
 * `OperationalScope.resolveDatabaseAuthority`): the role, not the presence of a gateway assertion, picks how the
 * scope is installed, and an unknown role fails closed. A description runs 12 scoped transactions, so it issues 12
 * more statements than before that check.
 */
const SCOPE_ROLE_READS = 12;

/**
 * The CI proof shape's round-trip bounds; before they were 13 transactions, 102 statements and 5 SpiceDB calls. It
 * measures 95 statements plus the scoped transactions' role reads.
 */
const CI_BOUNDS = { spicedb: 4, statements: 95 + SCOPE_ROLE_READS, transactions: 12 };

/**
 * One connection description as stage runs it, with `installed` the tenant's modules: its round trips per phase, and
 * its equivalence with the reference that asks every composed module (same acting authority; every evidence row
 * one the reference writes, the reference's others all about modules the tenant has not installed).
 */
const describedOnStage = Effect.fn('test.describedOnStage')(function* describedOnStage(input: {
  readonly authorityCase: AuthorityCase;
  readonly installed: readonly string[];
  readonly label: string;
  readonly principalId: string;
  /** Modules installed after the projection: their states are active, their rights not projected yet. */
  readonly unprojected?: readonly string[];
}) {
  const { authorityCase, installed, label, principalId } = input;
  const { companyId, tenantId } = authorityCase;
  const snapshot = yield* installedComposition;
  yield* authorityCase.reinstall(installed);
  if (input.unprojected !== undefined) {
    yield* authorityCase.reinstall([...installed, ...input.unprojected], { project: false });
  }
  const describe = (correlationId: string) =>
    measured({
      authorityCase,
      correlationId,
      read: describeConnectionOf({ authorityCase, correlationId, principalId }),
      snapshot,
    });
  yield* describe(`stage-${label}-warm-up`);
  const described = yield* describe(`stage-${label}`);
  const referenceScope = yield* sessionScope({
    correlationId: `stage-${label}-reference`,
    legalEntityId: companyId,
    principalId,
    tenantId,
  });
  const reference = yield* measured({
    authorityCase,
    correlationId: `stage-${label}-reference`,
    read: referenceActingAuthority({
      queryScope: { legalEntityId: companyId, tenantId },
      requesterScope: referenceScope,
      subject: { principalId, tenantId },
    }),
    snapshot,
  });
  const report = {
    checkItems: described.counters.checkItems,
    decisionRows: described.decisionRows,
    ms: described.ms,
    phases: phaseBreakdown(described.records),
    referenceRows: reference.decisionRows,
    referenceSpicedb: countOf(reference.spans, 'AccessDecision.spicedbCheckBulk'),
    referenceStatements: reference.statements,
    referenceTransactions: reference.transactions,
    spicedb: countOf(described.spans, 'AccessDecision.spicedbCheckBulk'),
    statements: described.statements,
    transactions: described.transactions,
  };
  const path = yield* descriptionReportPath;
  if (Option.isSome(path)) {
    yield* (yield* FileSystem.FileSystem).writeFileString(
      `${path.value}.${label}.json`,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(report),
    );
  }
  const { live, policyCap } = (yield* measured({
    authorityCase,
    correlationId: `stage-${label}-authority`,
    read: loadActingAuthority(referenceScope, {
      actingKind: 'human',
      actingPrincipalId: principalId,
      legalEntityId: companyId,
      tenantId,
    }),
    snapshot,
  })).value;
  expect(sortedSet(live.read)).toEqual(sortedSet(reference.value.read));
  expect(sortedSet(live.write)).toEqual(sortedSet(reference.value.write));
  expect(policyCap).toBe(reference.value.policyCap);
  const ownerOf = owningModules(yield* publishedCatalog);
  const remaining = [...reference.decisionRowContents];
  for (const row of described.decisionRowContents) {
    const at = remaining.indexOf(row);
    expect(at).toBeGreaterThanOrEqual(0);
    remaining.splice(at, 1);
  }
  const asked = new Set([...installed, ...(input.unprojected ?? [])]);
  expect(remaining.every((row) => !asked.has(ownerOf.get(keyOfRow(row)) ?? ''))).toBe(true);
  return { ...report, liveRead: sortedSet(live.read) };
});

const reportPath = Config.option(Config.String('ACTING_AUTHORITY_REPORT'));
const ownerReportPath = Config.option(Config.String('OWNER_AUTHORITY_REPORT'));
const roundTripReportPath = Config.option(Config.String('ROUND_TRIP_REPORT'));

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
            // One engine snapshot per capability batch and one for its LISTs together, however many LISTs it asks.
            expect(batch.counters.checkBulk).toBeLessThanOrEqual(4);
            expect(batch.transactions).toBeLessThanOrEqual(24);
            // Every cell set of a capability batch is read in ONE transaction, and its LISTs' in one more.
            expect(batch.cellBatches).toBeLessThanOrEqual(4);
            expect(batch.cellReads).toBe(0);
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
              expect(owned.counters.checkBulk).toBeLessThanOrEqual(4);
              // The work does not grow with the rights the catalog declares (hundreds): one batched cell read per
              // capability batch and one for its LISTs, a fixed number of identity, scope and evidence transactions.
              // Before the batch, this owner cost one transaction per capability and mode: 463 transactions, 3 252
              // statements.
              expect(owned.cellBatches).toBeLessThanOrEqual(4);
              expect(owned.cellReads).toBe(0);
              expect(owned.transactions).toBeLessThanOrEqual(24);
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

    // Stage reaches PostgreSQL and SpiceDB over the network, so every round trip of a description costs a network
    // delay. The description is counted by the counter the `mcp.request` and `agent-platform.request` lines carry:
    // its statements, transactions and SpiceDB calls. They count every round trip, concurrent or not.
    suite.effect(
      "counts the round trips of a full-access owner's connection description",
      () =>
        withAuthorityCase(
          'work.tasks',
          (authorityCase) =>
            Effect.gen(function* ownerRoundTrips() {
              const snapshot = yield* installedComposition;
              const describe = (label: string) => countedOwnerDescription({ authorityCase, label, snapshot });
              // A warm-up, so the counted description is the steady one every MCP request repeats.
              const warmUp = yield* describe('warm-up');
              const described = yield* describe('counted');
              const [authority, counted] = described.value;
              expect(authority.live.read).toEqual(warmUp.value[0].live.read);
              expect(authority.live.read.size).toBeGreaterThan(20);
              // The product counter sees every round trip this suite's own tracer records.
              expect(counted.statements).toBe(described.statements);
              expect(counted.transactions).toBe(described.transactions);
              expect(counted.spicedbCalls).toBe(countOf(described.spans, 'AccessDecision.spicedbCheckBulk'));
              const path = yield* roundTripReportPath;
              if (Option.isSome(path)) {
                const origin = Math.min(...described.records.map(({ startMs }) => startMs));
                const fileSystem = yield* FileSystem.FileSystem;
                yield* fileSystem.writeFileString(
                  path.value,
                  yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    counted,
                    described: reportOf(described),
                    phases: phaseBreakdown(described.records),
                    timeline: described.records
                      .filter(({ name }) => !name.startsWith('Schema') && !name.startsWith('measured'))
                      .toSorted((left, right) => left.startMs - right.startMs)
                      .map(({ ms, name, parents, startMs }) => ({
                        ms: Math.round(ms),
                        name,
                        parents,
                        t: Math.round(startMs - origin),
                      })),
                    warmUp: reportOf(warmUp),
                  }),
                );
              }
              // Three companies, the whole catalogue: 100 statements, 12 transactions and 4 SpiceDB check batches,
              // the same in the warm-up. One more of any is a new stage, a per-context resolution or a per-LIST read.
              // Statements: identity, scope, the batched cell reads and the evidence writes, never one per capability
              // (before the batch, 3 252). Transactions: the old proxy-measured bound was 14; there are 12. SpiceDB:
              // one check per capability batch and one for its LISTs together. With BEGIN and COMMIT per transaction
              // (no spans of their own), the description makes at most 100 + 2 * 12 + 4 = 128 round trips in all; the
              // proxy measured about 85 of them waiting on one another.
              expect(counted.statements).toBeLessThanOrEqual(100);
              expect(counted.transactions).toBeLessThanOrEqual(12);
              expect(counted.spicedbCalls).toBeLessThanOrEqual(4);
            }).pipe(Effect.provide(NodeServices.layer)),
          3,
        ),
      300_000,
    );

    suite.effect(
      "reproduces the stage owner's connection description: one company, approval policy",
      () =>
        withAuthorityCase(
          'work.tasks',
          (authorityCase) =>
            Effect.gen(function* stageOwnerDescription() {
              // Stage's N1 demo tenant installs these (plus one module the release does not compose); the owner holds
              // the full-access preset over the whole catalogue, but SpiceDB carries only installed modules' rights.
              const report = yield* describedOnStage({
                authorityCase,
                installed: N1_MODULES,
                label: 'owner',
                principalId: authorityCase.owner,
              });
              // Before: 23 transactions, 158 statements, 15 SpiceDB calls (12 LIST questions each with its own cell
              // read and snapshot) and 517 evidence rows; stage measured 24 / 164 / 16 with one more LIST.
              expect(report.transactions).toBeLessThanOrEqual(12);
              // 81 statements plus the scoped transactions' role reads.
              expect(report.statements).toBeLessThanOrEqual(81 + SCOPE_ROLE_READS);
              expect(report.spicedb).toBeLessThanOrEqual(4);
            }).pipe(Effect.provide(NodeServices.layer)),
          1,
        ),
      300_000,
    );

    suite.effect(
      'never offers a module installed in the database before its rights are projected',
      () =>
        withAuthorityCase(
          'work.tasks',
          (authorityCase) =>
            Effect.gen(function* unprojectedModule() {
              // facility.operations is installed (active) after the last projection: the owner's full-access cells
              // for it exist, but SpiceDB holds no relationship for them yet, so every question about it is denied.
              const report = yield* describedOnStage({
                authorityCase,
                installed: N1_MODULES,
                label: 'unprojected',
                principalId: authorityCase.owner,
                unprojected: ['facility.operations'],
              });
              expect(report.liveRead).not.toContain('facility.operations');
              expect(report.liveRead).toContain('work.tasks');
            }).pipe(Effect.provide(NodeServices.layer)),
          1,
        ),
      300_000,
    );

    suite.effect(
      "reproduces the CI proof's connection description: a company administrator of one of six companies",
      () =>
        withAuthorityCase(
          'work.tasks',
          (authorityCase) =>
            Effect.gen(function* companyAdministratorDescription() {
              const { admin, companyId, owner, person, tenantId } = authorityCase;
              // The person administers one company and holds the tenant's full-access preset there only.
              const [preset] = yield* admin.unsafe<{ readonly role_id: string; readonly role_revision_id: string }>(
                `select role_id, role_revision_id from core.access_role_revisions
                  where tenant_id = '${tenantId}' and template_key = 'full_access' order by revision desc limit 1`,
              );
              const [companyScope] = yield* admin.unsafe<{ readonly scope_id: string }>(
                `select scope_id from core.access_scopes where tenant_id = '${tenantId}' and legal_entity_id = '${companyId}'`,
              );
              expect(preset).toBeDefined();
              yield* admin.unsafe(
                `insert into core.access_memberships
                   (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
                 values (gen_random_uuid(), '${tenantId}', '${companyScope?.scope_id}', '${person}', 'access_admin',
                         'active', now() - interval '1 day', '${owner}')`,
              );
              yield* admin.unsafe(
                `insert into core.access_assignments
                   (incarnation_id, tenant_id, scope_id, principal_id, role_id, role_revision_id, status, assigned_by,
                    valid_from)
                 values (gen_random_uuid(), '${tenantId}', '${companyScope?.scope_id}', '${person}',
                         '${preset?.role_id}', '${preset?.role_revision_id}', 'active', '${owner}',
                         now() - interval '1 day')`,
              );
              const report = yield* describedOnStage({
                authorityCase,
                installed: MAIN_DEMO_MODULES,
                label: 'company-administrator',
                principalId: person,
              });
              expect(report.transactions).toBeLessThanOrEqual(CI_BOUNDS.transactions);
              expect(report.statements).toBeLessThanOrEqual(CI_BOUNDS.statements);
              expect(report.spicedb).toBeLessThanOrEqual(CI_BOUNDS.spicedb);
            }).pipe(Effect.provide(NodeServices.layer)),
          6,
        ),
      300_000,
    );
  },
);
