import { TestClock } from 'effect/testing';
import { expect, it } from '@app/effect-rstest';
import { NodeServices } from '@effect/platform-node';
import {
  makeFaultInjectableCoreDatabase,
  TestQueryHook,
} from '../../../../packages/core-runtime/tests/support/database-faults.ts';
import { SqlError, UnknownError } from 'effect/unstable/sql/SqlError';
import {
  Clock,
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Logger,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import {
  ContextAccess,
  GatewayAssertionRedemptionService,
  ReadRuntime,
  TenantModuleStateService,
  buildInstalledModuleCatalog,
  getVerticalRuntimeActions,
  getVerticalRuntimeEntrypoints,
} from '@app/core-runtime';
import type {
  ActionRegistration,
  ContextAccessService,
  DomainEventContractMap,
  GatewayAssertionRedemption,
  InstalledModuleCatalog,
  OntosModuleDeploymentContract,
  OperationalScopeResolverService,
  ReadRuntimeService,
  TrustedPrincipalContext,
  VerticalRuntimeRegistration,
} from '@app/core-runtime';
import { defineEffectBff, HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import type { EffectRuntimeLayer } from '@modern-js/plugin-bff/effect-edge';
import { HttpApi } from 'effect/unstable/httpapi';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { GatewayPrincipalVerifierLive } from '../../../../packages/gateway-principal-verifier/src/server.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../../../packages/core-runtime/src/operations/context.ts';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createSpiceDbPermissionClient,
} from '../../../../packages/core-runtime/src/permissions/client.ts';
import {
  makeContextAccess,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import {
  makeActionPermissionService,
  toSpiceDbActionObjectId,
} from '../../../../packages/core-runtime/src/permissions/service.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { deriveOntosModuleDeploymentContract } from '../../../../scripts/generate-ontos-module-contract.mts';
import {
  issueGatewayContextAssertion,
  makeGatewayIssuerLayer,
} from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerConfigValue } from '../../api/auth/gateway-issuer-config.ts';
import {
  ShellGovernedReads,
  createShellGovernedReadsLayer,
} from '../../api/modules/shell-governed-reads.ts';
import { ShellInstalledModuleCatalog } from '../../api/modules/installed-module-catalog.ts';
import { ShellCompositionFactoryLive } from '../../api/modules/shell-composition.ts';
import {
  ResourceRefSchema,
  ShellProviderUnavailableError,
  ShellResourceServicesFactoryLive,
  makeShellSearch,
} from '../../api/modules/shell-resources.ts';
import type { ShellResourceGateways } from '../../api/modules/shell-resources.ts';
import { GENERATED_OWNER, createGeneratedOwnerFixture } from './generated-owner-fixture.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });
const TestSpiceDbConfig = Config.all({
  endpoint: Config.string('SPICEDB_ENDPOINT').pipe(Config.withDefault('localhost:50051')),
  insecureLocal: Config.boolean('SPICEDB_INSECURE').pipe(Config.withDefault(true)),
  preSharedKey: Config.redacted('SPICEDB_PRESHARED_KEY').pipe(
    Config.withDefault(Redacted.make('ontos-local-development-key')),
  ),
}).pipe(
  Effect.map(({ endpoint, insecureLocal, preSharedKey }) => ({
    endpoint,
    insecureLocal,
    preSharedKey: Redacted.value(preSharedKey),
  })),
);
const testGatewayAssertionRedemption: GatewayAssertionRedemption = {
  consume: () => Effect.void,
};
type OwnerHttpHandler = ReturnType<ReturnType<typeof defineEffectBff>['createHandler']>;
const disposeOwnerHandlers = (handlers: readonly OwnerHttpHandler[]) =>
  Effect.forEach(
    handlers,
    (handler) =>
      Effect.tryPromise(() => handler.dispose()).pipe(Effect.catchCause(() => Effect.void)),
    { concurrency: 'unbounded', discard: true },
  );
const OwnerDetailSchema = Schema.Struct({
  fields: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  title: Schema.String,
});
const OwnerTimelineSchema = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      occurredAt: Schema.DateTimeUtcFromString,
      summary: Schema.String,
      timelineEntryId: Schema.String.pipe(Schema.brand('TimelineEntryId')),
    }),
  ),
  projectionLagging: Schema.Boolean,
});
const OwnerSearchSchema = Schema.Array(
  Schema.Struct({ ref: ResourceRefSchema, title: Schema.String }),
);
interface GeneratedOwnerModules {
  // Generated source is imported from a temporary path, so TypeScript cannot retain the private
  // Action-registration symbols across the dynamic module boundary. Runtime checks below prove it.
  readonly action: ReturnType<typeof getVerticalRuntimeActions>[number];
  readonly counts: {
    action: number;
    detail: number;
    list: number;
    search: number;
  };
  readonly detail: OwnerHttpHandler;
  readonly list: OwnerHttpHandler;
  readonly search: OwnerHttpHandler;
  readonly verifyActionPrincipal: (
    authorization: string | undefined,
    options: {
      readonly environment: Readonly<Record<string, string>>;
      readonly redemption: GatewayAssertionRedemption;
    },
  ) => Effect.Effect<TrustedPrincipalContext, unknown>;
  readonly wiring: {
    readonly action: boolean;
    readonly detailClient: boolean;
    readonly listClient: boolean;
    readonly searchClient: boolean;
  };
}
type OwnerApi = HttpApi.Top;
type OwnerGroupLayer = Layer.Layer<unknown, unknown, unknown>;
const DynamicModuleSchema = Schema.Record(Schema.String, Schema.Unknown);
const OwnerApiSchema = Schema.declare<OwnerApi>(HttpApi.isHttpApi);
const OwnerGroupLayerSchema = Schema.declare<OwnerGroupLayer>(Layer.isLayer);
const VerticalRuntimeRegistrationSchema = Schema.declare<VerticalRuntimeRegistration>(
  (value): value is VerticalRuntimeRegistration => Predicate.isObjectKeyword(value),
);
const OwnerCountsSchema = Schema.Struct({
  action: Schema.Number,
  detail: Schema.Number,
  list: Schema.Number,
  search: Schema.Number,
});
const OwnerVerifierSchema = Schema.declare<GeneratedOwnerModules['verifyActionPrincipal']>(
  (value): value is GeneratedOwnerModules['verifyActionPrincipal'] => Predicate.isFunction(value),
);
const EffectRuntimeLayerSchema = Schema.declare<EffectRuntimeLayer>(
  (value): value is EffectRuntimeLayer => Predicate.isObjectKeyword(value),
);
const isEffectRuntimeLayer = Schema.is(EffectRuntimeLayerSchema);
const requiredValue = <Value>(value: Value | null | undefined, label: string): Value => {
  if (value === undefined || value === null) {
    throw new TypeError(`${label} is required by the generated-owner fixture`);
  }
  return value;
};
const isOperationContextDenied = Schema.is(
  Schema.Struct({ _tag: Schema.Literal('OperationContextDenied') }),
);
const isCreateRecordRejected = Schema.is(
  Schema.Struct({ _tag: Schema.Literal('CreateRecordRejected') }),
);
const isActionHandlerExecutionError = Schema.is(
  Schema.Struct({ _tag: Schema.Literal('ActionHandlerExecutionError') }),
);
const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({ objectId: resourceId, objectType: resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: subjectId, objectType: subjectType }),
    }),
  });
const makeCatalog = (contract: OntosModuleDeploymentContract): InstalledModuleCatalog =>
  buildInstalledModuleCatalog([{ contract, expectedAppId: GENERATED_OWNER.appId }]);
const makeOwnerHandler = (
  api: OwnerApi,
  group: OwnerGroupLayer,
  runtime: ReadRuntimeService,
  loggerLayer: Layer.Layer<never>,
  configLayer: Layer.Layer<TestClock.TestClock>,
) => {
  const loggedRuntime: ReadRuntimeService = {
    runRead: (input) => runtime.runRead(input).pipe(Effect.provide(loggerLayer)),
  };
  const ownerLayerCandidate = HttpApiBuilder.layer(api).pipe(
    Layer.provide(group),
    Layer.provide(GatewayPrincipalVerifierLive),
    Layer.provide(Layer.succeed(GatewayAssertionRedemptionService, testGatewayAssertionRedemption)),
    Layer.provide(Layer.succeed(ReadRuntime, loggedRuntime)),
    Layer.provide(loggerLayer),
    Layer.provide(configLayer),
  );
  if (!isEffectRuntimeLayer(ownerLayerCandidate)) {
    throw new TypeError('Generated owner BFF Layer is invalid');
  }
  const ownerLayer = ownerLayerCandidate;
  const bff = defineEffectBff({ api, layer: ownerLayer });
  const handler: OwnerHttpHandler = bff.createHandler();
  return handler;
};
const loadGeneratedOwner = Effect.fnUntraced(function* runIntegration1(
  verticalRoot: string,
  runtime: ReadRuntimeService,
  loggerLayer: Layer.Layer<never>,
  configLayer: Layer.Layer<TestClock.TestClock>,
) {
  const load = Effect.fnUntraced(function* runIntegration2(relativePath: string) {
    const importedModule: unknown = yield* Effect.tryPromise(
      () => import(pathToFileURL(`${verticalRoot}/${relativePath}`).href),
    );
    return yield* Schema.decodeUnknownEffect(DynamicModuleSchema)(importedModule);
  });
  const [
    detailApi,
    detailServer,
    listApi,
    listServer,
    searchApi,
    searchServer,
    verifier,
    state,
    registrationOwner,
  ] = yield* Effect.all(
    [
      load('shared/apis/resource-detail.ts'),
      load('api/resource-detail-read-server.ts'),
      load('shared/apis/resource-list.ts'),
      load('api/resource-list-read-server.ts'),
      load('shared/apis/records-search.ts'),
      load('api/records-search-server.ts'),
      load('api/auth/action-principal.ts'),
      load('src/isolation/instrumentation.ts'),
      load('vertical.registration.ts'),
    ],
    { concurrency: 'unbounded' },
  );
  const registration = yield* Schema.decodeUnknownEffect(VerticalRuntimeRegistrationSchema)(
    registrationOwner['isolationOwnerRegistration'],
  );
  const actions = getVerticalRuntimeActions(registration);
  const entrypoints = getVerticalRuntimeEntrypoints(registration);
  const [detailClient, listClient, searchClient] = yield* Effect.all(
    [
      Effect.tryPromise(() => Promise.resolve(entrypoints.api['resource-detail']?.())),
      Effect.tryPromise(() => Promise.resolve(entrypoints.api['resource-list']?.())),
      Effect.tryPromise(() => Promise.resolve(entrypoints.search['records']?.())),
    ],
    { concurrency: 'unbounded' },
  );
  const generatedAction = actions.find(
    ({ descriptor }) => descriptor.actionKey === GENERATED_OWNER.actionKey,
  );
  if (generatedAction === undefined) {
    throw new TypeError('Generated Action is missing from the owner runtime registration');
  }
  return {
    action: generatedAction,
    counts: yield* Schema.decodeUnknownEffect(OwnerCountsSchema)(
      state['generatedOwnerHandlerCounts'],
    ),
    detail: makeOwnerHandler(
      yield* Schema.decodeUnknownEffect(OwnerApiSchema)(detailApi['ResourceDetailApi']),
      yield* Schema.decodeUnknownEffect(OwnerGroupLayerSchema)(
        detailServer['resourceDetailReadApiLive'],
      ),
      runtime,
      loggerLayer,
      configLayer,
    ),
    list: makeOwnerHandler(
      yield* Schema.decodeUnknownEffect(OwnerApiSchema)(listApi['ResourceListApi']),
      yield* Schema.decodeUnknownEffect(OwnerGroupLayerSchema)(
        listServer['resourceListReadApiLive'],
      ),
      runtime,
      loggerLayer,
      configLayer,
    ),
    search: makeOwnerHandler(
      yield* Schema.decodeUnknownEffect(OwnerApiSchema)(searchApi['RecordsSearchApi']),
      yield* Schema.decodeUnknownEffect(OwnerGroupLayerSchema)(searchServer['recordsReadApiLive']),
      runtime,
      loggerLayer,
      configLayer,
    ),
    verifyActionPrincipal: yield* Schema.decodeUnknownEffect(OwnerVerifierSchema)(
      verifier['verifyActionPrincipal'],
    ),
    wiring: {
      action: true,
      detailClient:
        detailClient !== undefined &&
        Predicate.isFunction(
          Object.getOwnPropertyDescriptor(detailClient, 'executeResourceDetailWithAuthorization')
            ?.value,
        ),
      listClient:
        listClient !== undefined &&
        Predicate.isFunction(
          Object.getOwnPropertyDescriptor(listClient, 'executeResourceListWithAuthorization')
            ?.value,
        ),
      searchClient:
        searchClient !== undefined &&
        Predicate.isFunction(
          Object.getOwnPropertyDescriptor(searchClient, 'loadRecordsClientWithAuthorization')
            ?.value,
        ),
    },
  };
});
const requestOwner = Effect.fnUntraced(function* runIntegration3<Payload>(
  handler: OwnerHttpHandler,
  path: string,
  payload: Payload,
  authorization: string,
  correlationId: string,
) {
  return yield* Effect.tryPromise(() =>
    handler.handler(
      new Request(`https://isolation-owner.example.test${path}`, {
        body: JSON.stringify(payload),
        headers: {
          authorization,
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
        },
        method: 'POST',
      }),
    ),
  );
});
const decodeResponse = Effect.fnUntraced(function* runIntegration4<
  ResponseSchema extends Schema.ConstraintDecoder<unknown>,
>(response: Response, schema: ResponseSchema) {
  return yield* Schema.decodeUnknownEffect(schema)(yield* Effect.tryPromise(() => response.json()));
});
const createOwnerSchema = Effect.fnUntraced(function* runIntegration5(
  admin: Pool,
  schemaName: string,
) {
  const tenantPredicate = `tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
  const entityPredicate = `${tenantPredicate} and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  // Dynamic identifiers are generated locally from UUID hex and never accept external input.
  yield* Effect.tryPromise(() => admin.query(`create schema ${schemaName}`));
  yield* Effect.tryPromise(() =>
    admin.query(`
    create table ${schemaName}.tenant_records (
      tenant_id uuid not null,
      resource_id uuid not null,
      title text not null,
      primary key (tenant_id, resource_id)
    )
  `),
  );
  yield* Effect.tryPromise(() =>
    admin.query(`
    create table ${schemaName}.entity_records (
      tenant_id uuid not null,
      legal_entity_id uuid not null,
      resource_id uuid not null,
      title text not null,
      primary key (tenant_id, legal_entity_id, resource_id)
    )
  `),
  );
  const configureTable = Effect.fnUntraced(function* runIntegration6(
    table: string,
    predicate: string,
  ) {
    yield* Effect.tryPromise(() =>
      admin.query(`alter table ${schemaName}.${table} enable row level security`),
    );
    yield* Effect.tryPromise(() =>
      admin.query(`alter table ${schemaName}.${table} force row level security`),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `create policy ${table}_select on ${schemaName}.${table} for select to ontos_runtime using (${predicate})`,
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `create policy ${table}_insert on ${schemaName}.${table} for insert to ontos_runtime with check (${predicate})`,
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `create policy ${table}_update on ${schemaName}.${table} for update to ontos_runtime using (${predicate}) with check (${predicate})`,
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `create policy ${table}_delete on ${schemaName}.${table} for delete to ontos_runtime using (${predicate})`,
      ),
    );
  });
  yield* Effect.all(
    [
      configureTable('tenant_records', tenantPredicate),
      configureTable('entity_records', entityPredicate),
    ],
    { concurrency: 'unbounded' },
  );
  yield* Effect.tryPromise(() =>
    admin.query(`grant usage on schema ${schemaName} to ontos_runtime`),
  );
  yield* Effect.tryPromise(() =>
    admin.query(
      `grant select, insert, update, delete on all tables in schema ${schemaName} to ontos_runtime`,
    ),
  );
});
type CoreDatabaseService = Parameters<typeof makeActionRuntime>[0];
type RuntimeActionRegistration = ActionRegistration<
  Schema.ConstraintDecoder<unknown>,
  Schema.ConstraintDecoder<unknown>,
  Schema.ConstraintDecoder<{
    readonly _tag: string;
  }>,
  DomainEventContractMap,
  string,
  unknown
>;
const RuntimeActionRegistrationSchema = Schema.declare<RuntimeActionRegistration>(
  (value): value is RuntimeActionRegistration => Predicate.isObjectKeyword(value),
);
const isRuntimeActionRegistration = Schema.is(RuntimeActionRegistrationSchema);
const failingEvidenceDatabase = (database: CoreDatabaseService): CoreDatabaseService => {
  const transactionOverride = {
    transaction: (runInTransaction, configuration) =>
      database.executor.transaction(
        (transaction) =>
          runInTransaction(transaction).pipe(
            Effect.provideService(TestQueryHook, (statement) =>
              statement.startsWith('insert into "core"."data_access_events"')
                ? Effect.fail(
                    new SqlError({
                      reason: new UnknownError({
                        cause: new Error('Injected SQL failure'),
                        message: 'Injected evidence persistence failure',
                      }),
                    }),
                  )
                : Effect.void,
            ),
          ),
        configuration,
      ),
  } satisfies Pick<CoreDatabaseService['executor'], 'transaction'>;
  const executor: CoreDatabaseService['executor'] = Object.assign(
    Object.create(database.executor),
    transactionOverride,
  );
  return { executor };
};
const capturedLoggerLayer = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);
const ignoreOperationFailure = <Value, Failure>(
  operation: () => Effect.Effect<Value, Failure>,
): Effect.Effect<void> => operation().pipe(Effect.ignore);
const principal = (
  tenantId: string,
  legalEntityId: string,
  principalId: string,
  authBindingId: string,
): TrustedPrincipalContext => ({
  authBindingId,
  authContextRef: `better-auth-session:${authBindingId}`,
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
});
it.live(
  'Codesmith composes the disposable owner Action and receiving read BFFs',
  Effect.fnUntraced(function* runIntegration7() {
    const fixture = yield* createGeneratedOwnerFixture(
      `generated_owner_${randomUUID().replaceAll('-', '')}`,
    ).pipe(Effect.provide(NodeServices.layer));
    const contract = yield* deriveOntosModuleDeploymentContract({
      vertical: GENERATED_OWNER.slug,
      workspaceRoot: fixture.root,
    }).pipe(Effect.provide(NodeServices.layer));
    const compileRuntime: ReadRuntimeService = {
      runRead: () => Effect.die(new Error('The compile fixture must not execute a governed read')),
    };
    const generated = yield* loadGeneratedOwner(
      fixture.verticalRoot,
      compileRuntime,
      capturedLoggerLayer([]),
      TestClock.layer(),
    );
    yield* Effect.acquireRelease(
      Effect.void,
      Effect.fnUntraced(function* integrationEffect8() {
        yield* disposeOwnerHandlers([generated.detail, generated.list, generated.search]);
      }, Effect.orDie),
    );
    expect(makeCatalog(contract).getByModuleId(GENERATED_OWNER.moduleId)).toEqual(contract);
    expect(generated.action.descriptor.actionKey).toBe(GENERATED_OWNER.actionKey);
    expect(generated.action.descriptor.legalEntityScope).toBe('required');
    expect(generated.counts).toEqual({ action: 0, detail: 0, list: 0, search: 0 });
    expect(generated.wiring).toEqual({
      action: true,
      detailClient: true,
      listClient: true,
      searchClient: true,
    });
  }),
);
it.live(
  'generated owner enforces tenant and legal-entity isolation through Shell, BFF, CoreSDK, SpiceDB, and RLS',
  Effect.fnUntraced(function* runIntegration9() {
    const schemaName = `generated_owner_${randomUUID().replaceAll('-', '')}`;
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const entityA1 = randomUUID();
    const entityA2 = randomUUID();
    const entityB1 = randomUUID();
    const entityB2 = randomUUID();
    const principalA = randomUUID();
    const principalB = randomUUID();
    const bindingA = randomUUID();
    const bindingB = randomUUID();
    const collidingResourceId = randomUUID();
    const deniedResourceId = randomUUID();
    const testClockLayer = TestClock.layer();
    const connections = yield* loadDatabaseConnectionPair();
    expect(connections.runtime.user).toBe('ontos_runtime');
    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
      (pool) => Effect.tryPromise(() => pool.end()).pipe(Effect.orDie),
    );
    // Shell and the independently deployed owner hold separate nested read transactions in this
    // in-process fixture, so the shared test pool needs more than one physical connection.
    const runtimePool = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Pool({
            connectionString: connections.runtime.connectionString,
            max: 4,
          }),
      ),
      (pool) => Effect.tryPromise(() => pool.end()).pipe(Effect.orDie),
    );
    const runtimeDatabase = yield* makeFaultInjectableCoreDatabase(connections.runtime);
    const fixture = yield* createGeneratedOwnerFixture(schemaName).pipe(
      Effect.provide(NodeServices.layer),
    );
    const contract = yield* deriveOntosModuleDeploymentContract({
      vertical: GENERATED_OWNER.slug,
      workspaceRoot: fixture.root,
    }).pipe(Effect.provide(NodeServices.layer));
    const capturedLogs: string[] = [];
    const loggerLayer = capturedLoggerLayer(capturedLogs);
    const testSpiceDb = yield* TestSpiceDbConfig;
    const spiceAdmin = v1.NewClient(
      testSpiceDb.preSharedKey,
      testSpiceDb.endpoint,
      testSpiceDb.insecureLocal
        ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
        : v1.ClientSecurity.SECURE,
    );
    const permissionClient = createSpiceDbPermissionClient(testSpiceDb, SPICEDB_CHECK_TIMEOUT_MS);
    const contextAccess = makeContextAccess(permissionClient);
    const moduleStates = makeTenantModuleStateService(runtimeDatabase);
    const moduleStateGate = makeModuleStateGate(moduleStates);
    const moduleGateway = makeModuleEntrypointGateway(moduleStateGate);
    const scopeResolver = makeOperationalScopeResolver(
      makeOperationalScopeRepository(runtimeDatabase),
      contextAccess,
    );
    const readRuntime = makeReadRuntime(
      runtimeDatabase,
      moduleGateway,
      scopeResolver,
      contextAccess,
    );
    const keyPair = yield* Effect.tryPromise(() =>
      generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
    );
    const privateJwk = yield* Effect.tryPromise(() => exportJWK(keyPair.privateKey));
    const publicJwk = yield* Effect.tryPromise(() => exportJWK(keyPair.publicKey));
    const issuerConfiguration: GatewayIssuerConfigValue = {
      issuer: 'https://shell.isolation.test',
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: requiredValue(privateJwk.d, 'Private JWK scalar'),
        kid: 'generated-owner-test',
        kty: 'OKP',
        use: 'sig',
        x: requiredValue(privateJwk.x, 'Private JWK public coordinate'),
      },
    };
    const verifierEnvironment = {
      ONTOS_GATEWAY_ISSUER: issuerConfiguration.issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [
          {
            ...publicJwk,
            alg: 'EdDSA',
            kid: issuerConfiguration.privateJwk.kid,
            use: 'sig',
          },
        ],
      }),
    };
    const verifierConfigLayer = Layer.merge(
      testClockLayer,
      ConfigProvider.layer(ConfigProvider.fromUnknown(verifierEnvironment)),
    );
    const generated = yield* loadGeneratedOwner(
      fixture.verticalRoot,
      readRuntime,
      loggerLayer,
      verifierConfigLayer,
    );
    const handlers: OwnerHttpHandler[] = [generated.detail, generated.list, generated.search];
    let assertionCount = 0;
    const issueAuthorization = Effect.fnUntraced(function* runIntegration10(
      principalContext: TrustedPrincipalContext,
    ) {
      return yield* issueGatewayContextAssertion({
        audience: GENERATED_OWNER.appId,
        principal: principalContext,
      }).pipe(
        Effect.provide(
          makeGatewayIssuerLayer({
            currentTimeSeconds: Clock.currentTimeMillis.pipe(
              Effect.map((milliseconds) => Math.floor(milliseconds / 1000)),
            ),
            generateJti: Effect.sync(() => {
              assertionCount += 1;
              return randomUUID();
            }),
            loadAudiences: Effect.succeed(new Set([GENERATED_OWNER.appId])),
            loadConfig: Effect.succeed(issuerConfiguration),
          }),
        ),
        Effect.map(({ token }) => `Bearer ${token}`),
        Effect.provide(testClockLayer),
      );
    });
    const principalA1 = principal(tenantA, entityA1, principalA, bindingA);
    const principalB1 = principal(tenantB, entityB1, principalB, bindingB);
    const issueProviderAuthorization = Effect.fnUntraced(function* runIntegration11(
      context: TrustedPrincipalContext,
    ) {
      return yield* issueAuthorization(
        withOptionalProperty(
          withOptionalProperty(
            withOptionalProperty(
              withOptionalProperty(
                {
                  authMethod: context.authMethod,
                  principalId: context.principalId,
                  tenantId: context.tenantId,
                },
                context.authBindingId !== undefined,
                'authBindingId',
                context.authBindingId,
                {},
              ),
              context.authContextRef !== undefined,
              'authContextRef',
              context.authContextRef,
              {},
            ),
            context.impersonatedByPrincipalId !== undefined,
            'impersonatedByPrincipalId',
            context.impersonatedByPrincipalId,
            {},
          ),
          context.legalEntityId !== undefined,
          'legalEntityId',
          context.legalEntityId,
          {},
        ),
      );
    });
    const resourceRef = yield* Schema.decodeUnknownEffect(ResourceRefSchema)({
      moduleId: GENERATED_OWNER.moduleId,
      resourceId: collidingResourceId,
      resourceType: GENERATED_OWNER.resourceType,
    });
    const touchedObjects: readonly [string, string][] = [
      ['tenant', tenantA],
      ['tenant', tenantB],
      [
        'legal_entity',
        requiredValue(toLegalEntityAccessObjectId(tenantA, entityA1), 'Tenant A legal entity'),
      ],
      [
        'legal_entity',
        requiredValue(toLegalEntityAccessObjectId(tenantB, entityB1), 'Tenant B legal entity'),
      ],
      [
        'module_access',
        requiredValue(
          toModuleAccessObjectId(tenantA, entityA1, GENERATED_OWNER.moduleId),
          'Tenant A module access',
        ),
      ],
      [
        'module_access',
        requiredValue(
          toModuleAccessObjectId(tenantB, entityB1, GENERATED_OWNER.moduleId),
          'Tenant B module access',
        ),
      ],
      [
        'resource',
        requiredValue(
          toResourceAccessObjectId(tenantA, entityA1, resourceRef),
          'Tenant A resource',
        ),
      ],
      [
        'resource',
        requiredValue(
          toResourceAccessObjectId(tenantB, entityB1, resourceRef),
          'Tenant B resource',
        ),
      ],
      ['action', toSpiceDbActionObjectId(GENERATED_OWNER.actionKey)],
    ];
    yield* Effect.acquireRelease(
      Effect.void,
      Effect.fnUntraced(function* integrationEffect12() {
        yield* disposeOwnerHandlers(handlers);
        yield* Effect.forEach(
          touchedObjects.toReversed(),
          ([resourceType, resourceId]) =>
            Effect.tryPromise(() =>
              spiceAdmin.promises.deleteRelationships(
                v1.DeleteRelationshipsRequest.create({
                  relationshipFilter: v1.RelationshipFilter.create({
                    optionalResourceId: resourceId,
                    resourceType,
                  }),
                }),
              ),
            ).pipe(Effect.catchCause(() => Effect.void)),
          { concurrency: 1, discard: true },
        );
        permissionClient.close();
        spiceAdmin.close();
        const cleanupQueries = [
          Effect.fnUntraced(function* runIntegration15() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.outbox_messages where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration16() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.domain_events where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration17() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.data_access_events where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration18() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.audit_events where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration19() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.action_invocations where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration20() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.tenant_module_states where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration21() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.principal_auth_bindings where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration22() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.principals where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration23() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.legal_entities where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration24() {
            return yield* Effect.tryPromise(() =>
              admin.query('delete from core.tenants where tenant_id in ($1, $2)', [
                tenantA,
                tenantB,
              ]),
            );
          }),
          Effect.fnUntraced(function* runIntegration25() {
            return yield* Effect.tryPromise(() =>
              admin.query(`drop schema if exists ${schemaName} cascade`),
            );
          }),
        ];
        yield* Effect.forEach(cleanupQueries, ignoreOperationFailure, {
          concurrency: 1,
          discard: true,
        });
      }, Effect.orDie),
    );
    yield* createOwnerSchema(admin, schemaName);
    yield* Effect.tryPromise(() =>
      admin.query(
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $3, 'Generated tenant A', 'active', 'en'), ($2, $4, 'Generated tenant B', 'active', 'en')`,
        [tenantA, tenantB, `generated-a-${tenantA}`, `generated-b-${tenantB}`],
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $5, 'A1', 'CZ', $7, 'active'), ($2, $5, 'A2', 'CZ', $8, 'active'), ($3, $6, 'B1', 'CZ', $9, 'active'), ($4, $6, 'B2', 'CZ', $10, 'active')`,
        [
          entityA1,
          entityA2,
          entityB1,
          entityB2,
          tenantA,
          tenantB,
          `A1-${entityA1}`,
          `A2-${entityA2}`,
          `B1-${entityB1}`,
          `B2-${entityB2}`,
        ],
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $3, 'human', 'Generated principal A', 'active'), ($2, $4, 'human', 'Generated principal B', 'active')`,
        [principalA, principalB, tenantA, tenantB],
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type, provider_subject_id, status) values ($1, $3, $5, 'better_auth', 'user', $7, 'active'), ($2, $4, $6, 'better_auth', 'user', $8, 'active')`,
        [
          bindingA,
          bindingB,
          tenantA,
          tenantB,
          principalA,
          principalB,
          `user-${principalA}`,
          `user-${principalB}`,
        ],
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, $3, 'active'), ($2, $3, 'active')`,
        [tenantA, tenantB, GENERATED_OWNER.moduleId],
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `insert into ${schemaName}.tenant_records (tenant_id, resource_id, title) values ($1, $3, 'Tenant A list'), ($2, $3, 'Tenant B list')`,
        [tenantA, tenantB, collidingResourceId],
      ),
    );
    yield* Effect.tryPromise(() =>
      admin.query(
        `insert into ${schemaName}.entity_records (tenant_id, legal_entity_id, resource_id, title) values ($1, $2, $7, 'A1 searchable'), ($1, $3, $7, 'A2 searchable'), ($4, $5, $7, 'B1 searchable'), ($4, $6, $7, 'B2 searchable')`,
        [tenantA, entityA1, entityA2, tenantB, entityB1, entityB2, collidingResourceId],
      ),
    );
    const legalA = requiredValue(
      toLegalEntityAccessObjectId(tenantA, entityA1),
      'Tenant A legal entity',
    );
    const legalB = requiredValue(
      toLegalEntityAccessObjectId(tenantB, entityB1),
      'Tenant B legal entity',
    );
    const moduleA = requiredValue(
      toModuleAccessObjectId(tenantA, entityA1, GENERATED_OWNER.moduleId),
      'Tenant A module access',
    );
    const moduleB = requiredValue(
      toModuleAccessObjectId(tenantB, entityB1, GENERATED_OWNER.moduleId),
      'Tenant B module access',
    );
    const resourceA = requiredValue(
      toResourceAccessObjectId(tenantA, entityA1, resourceRef),
      'Tenant A resource',
    );
    const resourceB = requiredValue(
      toResourceAccessObjectId(tenantB, entityB1, resourceRef),
      'Tenant B resource',
    );
    const actionId = toSpiceDbActionObjectId(GENERATED_OWNER.actionKey);
    const relationships = [
      relationship('tenant', tenantA, 'member', 'principal', principalA),
      relationship('tenant', tenantB, 'member', 'principal', principalB),
      relationship('legal_entity', legalA, 'tenant', 'tenant', tenantA),
      relationship('legal_entity', legalA, 'member', 'principal', principalA),
      relationship('legal_entity', legalB, 'tenant', 'tenant', tenantB),
      relationship('legal_entity', legalB, 'member', 'principal', principalB),
      relationship('module_access', moduleA, 'legal_entity', 'legal_entity', legalA),
      relationship('module_access', moduleA, 'accessor', 'principal', principalA),
      relationship('module_access', moduleB, 'legal_entity', 'legal_entity', legalB),
      relationship('module_access', moduleB, 'accessor', 'principal', principalB),
      relationship('resource', resourceA, 'module', 'module_access', moduleA),
      relationship('resource', resourceA, 'reader', 'principal', principalA),
      relationship('resource', resourceB, 'module', 'module_access', moduleB),
      relationship('resource', resourceB, 'reader', 'principal', principalB),
      relationship('action', actionId, 'restriction', 'action', actionId),
      relationship('action', actionId, 'executor', 'principal', principalA),
    ];
    yield* Effect.tryPromise(() =>
      spiceAdmin.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relationships.map((item) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: item,
            }),
          ),
        }),
      ),
    );
    const ownerSearchProbe = yield* requestOwner(
      generated.search,
      `/${GENERATED_OWNER.moduleId}/search/records`,
      { query: 'searchable' },
      yield* issueAuthorization(principalA1),
      randomUUID(),
    );
    const ownerSearchProbeBody = yield* decodeResponse(ownerSearchProbe, OwnerSearchSchema);
    expect(ownerSearchProbe.status, JSON.stringify(ownerSearchProbeBody)).toBe(200);
    expect(ownerSearchProbeBody.map(({ title }) => title)).toEqual(['A1 searchable']);
    const catalog = makeCatalog(contract);
    const gateway = {
      resource: {
        detail: Effect.fnUntraced(
          function* integrationEffect26({
            authorization,
            correlationId,
            ref,
          }: Parameters<ShellResourceGateways['resource']['detail']>[0]) {
            const response = yield* requestOwner(
              generated.detail,
              '/reads/resource-detail',
              { resourceId: ref.resourceId },
              authorization,
              correlationId,
            );
            if (!response.ok) {
              throw new Error('Owner detail request failed');
            }
            return yield* decodeResponse(response, OwnerDetailSchema);
          },
          Effect.catchCause(() => Effect.fail(new ShellProviderUnavailableError())),
        ),
        timeline: Effect.fnUntraced(
          function* integrationEffect27({
            authorization,
            correlationId,
            ref,
          }: Parameters<ShellResourceGateways['resource']['timeline']>[0]) {
            const response = yield* requestOwner(
              generated.list,
              '/reads/resource-list',
              { resourceId: ref.resourceId },
              authorization,
              correlationId,
            );
            if (!response.ok) {
              throw new Error('Owner list request failed');
            }
            const timeline = yield* decodeResponse(response, OwnerTimelineSchema);
            return Schema.encodeSync(OwnerTimelineSchema)(timeline);
          },
          Effect.catchCause(() => Effect.fail(new ShellProviderUnavailableError())),
        ),
      },
      search: {
        search: Effect.fnUntraced(
          function* integrationEffect28({
            authorization,
            correlationId,
            query,
          }: Parameters<ShellResourceGateways['search']['search']>[0]) {
            const response = yield* requestOwner(
              generated.search,
              `/${GENERATED_OWNER.moduleId}/search/records`,
              { query },
              authorization,
              correlationId,
            );
            if (!response.ok) {
              throw new Error('Owner search request failed');
            }
            return yield* decodeResponse(response, OwnerSearchSchema);
          },
          Effect.catchCause(() => Effect.fail(new ShellProviderUnavailableError())),
        ),
      },
    } satisfies ShellResourceGateways;
    expect(yield* moduleStates.getTenantModuleStates(tenantA, [GENERATED_OWNER.moduleId])).toEqual([
      { moduleKey: GENERATED_OWNER.moduleId, state: 'active' },
    ]);
    expect(
      yield* contextAccess.modules({
        legalEntityId: entityA1,
        moduleIds: [GENERATED_OWNER.moduleId],
        principalId: principalA,
        tenantId: tenantA,
      }),
    ).toEqual([{ decision: 'allowed', key: GENERATED_OWNER.moduleId }]);
    expect(
      yield* contextAccess.resources({
        legalEntityId: entityA1,
        principalId: principalA,
        resources: [resourceRef],
        tenantId: tenantA,
      }),
    ).toEqual([
      {
        decision: 'allowed',
        key: `${GENERATED_OWNER.moduleId}:${GENERATED_OWNER.resourceType}:${collidingResourceId}`,
      },
    ]);
    expect(
      yield* gateway.search.search({
        appId: GENERATED_OWNER.appId,
        authorization: yield* issueAuthorization(principalA1),
        correlationId: randomUUID(),
        query: 'searchable',
        searchKey: `${GENERATED_OWNER.moduleId}.records`,
      }),
    ).toEqual([
      {
        ref: resourceRef,
        title: 'A1 searchable',
      },
    ]);
    const directShellSearch = makeShellSearch(
      {
        catalog: Effect.succeed(catalog),
        contextAccess,
        issueAssertion: Effect.fnUntraced(
          function* integrationEffect29({
            context,
          }: {
            readonly context: TrustedPrincipalContext;
          }) {
            return yield* issueProviderAuthorization(context);
          },
          Effect.catchCause(() => Effect.fail(new ShellProviderUnavailableError())),
        ),
        moduleStates,
      },
      gateway.search,
    );
    expect(
      yield* directShellSearch.search(
        { ...principalA1, correlationId: randomUUID(), legalEntityId: entityA1 },
        'searchable',
      ),
    ).toEqual({
      partial: false,
      results: [{ kind: 'resource', ref: resourceRef, title: 'A1 searchable' }],
    });
    const shellLayer = createShellGovernedReadsLayer(
      gateway,
      {
        issueAssertion: Effect.fnUntraced(
          function* integrationEffect30({
            context,
          }: {
            readonly context: TrustedPrincipalContext;
          }) {
            return yield* issueProviderAuthorization(context);
          },
          Effect.catchCause(() => Effect.fail(new ShellProviderUnavailableError())),
        ),
      },
      (transaction) => makeTenantModuleStateService({ executor: transaction }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ReadRuntime, readRuntime),
          Layer.succeed(ContextAccess, contextAccess),
          Layer.succeed(TenantModuleStateService, moduleStates),
          Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
          ShellCompositionFactoryLive,
          ShellResourceServicesFactoryLive,
        ),
      ),
    );
    const shellReads = yield* ShellGovernedReads.pipe(Effect.provide(shellLayer));
    const searchA = yield* shellReads.search({
      correlationId: randomUUID(),
      principal: principalA1,
      query: 'searchable',
    });
    const detailA = yield* shellReads.resourceDetail({
      correlationId: randomUUID(),
      principal: principalA1,
      ref: resourceRef,
    });
    const searchB = yield* shellReads.search({
      correlationId: randomUUID(),
      principal: principalB1,
      query: 'searchable',
    });
    const detailB = yield* shellReads.resourceDetail({
      correlationId: randomUUID(),
      principal: principalB1,
      ref: resourceRef,
    });
    expect(searchA.results.map(({ title }) => title)).toEqual(['A1 searchable']);
    expect(detailA.detail.title).toBe('A1 searchable');
    expect(detailA.timeline.map(({ summary }) => summary)).toEqual(['Tenant A list']);
    expect(searchB.results.map(({ title }) => title)).toEqual(['B1 searchable']);
    expect(detailB.detail.title).toBe('B1 searchable');
    expect(detailB.timeline.map(({ summary }) => summary)).toEqual(['Tenant B list']);
    expect(assertionCount, 'every provider attempt must receive a fresh assertion').toBe(9);
    capturedLogs.length = 0;
    const beforeForgedShell = { ...generated.counts };
    expect(
      isOperationContextDenied(
        yield* Effect.flip(
          shellReads.resourceDetail({
            correlationId: randomUUID(),
            principal: principal(tenantA, entityA2, principalA, bindingA),
            ref: resourceRef,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isOperationContextDenied(
        yield* Effect.flip(
          shellReads.resourceDetail({
            correlationId: randomUUID(),
            principal: principal(tenantB, entityB1, principalA, bindingA),
            ref: resourceRef,
          }),
        ),
      ),
    ).toBe(true);
    expect(generated.counts).toEqual(beforeForgedShell);
    expect(assertionCount).toBe(9);
    yield* Effect.all(
      [
        principal(tenantA, entityA2, principalA, bindingA),
        principal(tenantB, entityB1, principalA, bindingA),
      ].map(
        Effect.fnUntraced(function* runIntegration31(forgedPrincipal) {
          const authorization = yield* issueAuthorization(forgedPrincipal);
          const response = yield* requestOwner(
            generated.detail,
            '/reads/resource-detail',
            { resourceId: collidingResourceId },
            authorization,
            randomUUID(),
          );
          expect(response.status).toBe(403);
          const problem = JSON.stringify(yield* Effect.tryPromise(() => response.json()));
          expect(problem).not.toMatch(
            new RegExp([tenantA, tenantB, entityA2, entityB1].join('|'), 'u'),
          );
          expect(problem).not.toMatch(/postgres|spicedb|permission check|row-level/iu);
        }),
      ),
    );
    expect(generated.counts).toEqual(beforeForgedShell);
    const deniedBefore = generated.counts.detail;
    const deniedAuthorization = yield* issueAuthorization(principalA1);
    const deniedResponse = yield* requestOwner(
      generated.detail,
      '/reads/resource-detail',
      { resourceId: deniedResourceId },
      deniedAuthorization,
      randomUUID(),
    );
    expect(deniedResponse.status).toBe(403);
    expect(generated.counts.detail).toBe(deniedBefore);
    const deniedEvidence = yield* Effect.tryPromise(() =>
      admin.query<{
        outcome: string;
        outcome_code: string;
        query_hash: null;
        result_count: number;
      }>(
        `select outcome, outcome_code, query_hash, result_count from core.data_access_events where tenant_id = $1 and target_resource_id = $2`,
        [tenantA, deniedResourceId],
      ),
    );
    expect(deniedEvidence.rows).toEqual([
      {
        outcome: 'denied',
        outcome_code: 'spicedb_permission_denied',
        query_hash: null,
        result_count: 0,
      },
    ]);
    const unavailableContextAccess: ContextAccessService = {
      legalEntities: ({ legalEntityIds }) =>
        Effect.succeed(legalEntityIds.map((key) => ({ decision: 'unavailable' as const, key }))),
      modules: ({ moduleIds }) =>
        Effect.succeed(moduleIds.map((key) => ({ decision: 'unavailable' as const, key }))),
      resources: ({ resources }) =>
        Effect.succeed(
          resources.map(({ moduleId, resourceId, resourceType }) => ({
            decision: 'unavailable' as const,
            key: `${moduleId}:${resourceType}:${resourceId}`,
          })),
        ),
      tenants: ({ tenantIds }) =>
        Effect.succeed(tenantIds.map((key) => ({ decision: 'unavailable' as const, key }))),
    };
    const unavailableResolver: OperationalScopeResolverService = makeOperationalScopeResolver(
      makeOperationalScopeRepository(runtimeDatabase),
      unavailableContextAccess,
    );
    const unavailableRuntime = makeReadRuntime(
      runtimeDatabase,
      moduleGateway,
      unavailableResolver,
      unavailableContextAccess,
    );
    const unavailableOwner = yield* loadGeneratedOwner(
      fixture.verticalRoot,
      unavailableRuntime,
      loggerLayer,
      verifierConfigLayer,
    );
    handlers.push(unavailableOwner.detail, unavailableOwner.list, unavailableOwner.search);
    const unavailableBefore = generated.counts.detail;
    const unavailableResponse = yield* requestOwner(
      unavailableOwner.detail,
      '/reads/resource-detail',
      { resourceId: collidingResourceId },
      yield* issueAuthorization(principalA1),
      randomUUID(),
    );
    expect(unavailableResponse.status).toBe(503);
    expect(generated.counts.detail).toBe(unavailableBefore);
    expect(JSON.stringify(yield* Effect.tryPromise(() => unavailableResponse.json()))).not.toMatch(
      /postgres|spicedb|permission check|row-level/iu,
    );
    const evidenceFailureRuntime = makeReadRuntime(
      failingEvidenceDatabase(runtimeDatabase),
      moduleGateway,
      scopeResolver,
      contextAccess,
    );
    const evidenceFailureOwner = yield* loadGeneratedOwner(
      fixture.verticalRoot,
      evidenceFailureRuntime,
      loggerLayer,
      verifierConfigLayer,
    );
    handlers.push(
      evidenceFailureOwner.detail,
      evidenceFailureOwner.list,
      evidenceFailureOwner.search,
    );
    const evidenceFailureResponse = yield* requestOwner(
      evidenceFailureOwner.detail,
      '/reads/resource-detail',
      { resourceId: collidingResourceId },
      yield* issueAuthorization(principalA1),
      randomUUID(),
    );
    expect(evidenceFailureResponse.status).toBe(503);
    expect(
      JSON.stringify(yield* Effect.tryPromise(() => evidenceFailureResponse.json())),
    ).not.toMatch(/A1 searchable/u);
    const actionRuntime = makeActionRuntime(
      runtimeDatabase,
      makeActionRepository(),
      makeActionPermissionService(permissionClient),
      scopeResolver,
      { moduleEntrypointGateway: moduleGateway, moduleStateGate },
    );
    if (!isRuntimeActionRegistration(generated.action)) {
      throw new TypeError('Generated Action registration is missing its runtime handler');
    }
    const actionRegistration = generated.action;
    const invokeAction = Effect.fnUntraced(function* runIntegration32(
      trustedPrincipal: TrustedPrincipalContext,
      payload: {
        readonly legalEntityId: string;
        readonly resourceId: string;
        readonly tenantId: string;
        readonly title: string;
      },
      idempotencyKey: string,
    ) {
      const authorization = yield* issueAuthorization(trustedPrincipal);
      const verified = yield* generated
        .verifyActionPrincipal(authorization, {
          environment: verifierEnvironment,
          redemption: testGatewayAssertionRedemption,
        })
        .pipe(Effect.provide(testClockLayer));
      return yield* actionRuntime
        .runAction({
          payload,
          principal: verified,
          registration: actionRegistration,
          transport: {
            correlationId: randomUUID(),
            idempotencyKey,
            targetModuleKey: GENERATED_OWNER.moduleId,
            targetResourceId: payload.resourceId,
            targetResourceType: GENERATED_OWNER.resourceType,
          },
        })
        .pipe(Effect.provide(loggerLayer));
    });
    const validWriteId = randomUUID();
    expect(
      yield* invokeAction(
        principalA1,
        {
          legalEntityId: entityA1,
          resourceId: validWriteId,
          tenantId: tenantA,
          title: 'A1 action write',
        },
        randomUUID(),
      ),
    ).toEqual({ created: true });
    yield* Effect.all(
      [
        {
          legalEntityId: entityA2,
          resourceId: randomUUID(),
          tenantId: tenantA,
          title: 'forbidden entity write',
        },
        {
          legalEntityId: entityB1,
          resourceId: randomUUID(),
          tenantId: tenantB,
          title: 'forbidden tenant write',
        },
      ].map(
        Effect.fnUntraced(function* runIntegration33(payload) {
          expect(
            isCreateRecordRejected(
              yield* Effect.flip(invokeAction(principalA1, payload, randomUUID())),
            ),
          ).toBe(true);
        }),
      ),
    );
    const beforeForgedAction = generated.counts.action;
    expect(
      isOperationContextDenied(
        yield* Effect.flip(
          invokeAction(
            principal(tenantA, entityA2, principalA, bindingA),
            {
              legalEntityId: entityA2,
              resourceId: randomUUID(),
              tenantId: tenantA,
              title: 'forged action scope',
            },
            randomUUID(),
          ),
        ),
      ),
    ).toBe(true);
    expect(generated.counts.action).toBe(beforeForgedAction);
    expect(
      isActionHandlerExecutionError(
        yield* Effect.flip(
          invokeAction(
            principalA1,
            {
              legalEntityId: entityA1,
              resourceId: randomUUID(),
              tenantId: tenantA,
              title: 'trigger safe logging defect',
            },
            randomUUID(),
          ),
        ),
      ),
    ).toBe(true);
    const ownerRows = yield* Effect.tryPromise(() =>
      admin.query<{
        legal_entity_id: string;
        tenant_id: string;
        title: string;
      }>(
        `select tenant_id, legal_entity_id, title from ${schemaName}.entity_records order by title`,
      ),
    );
    expect(ownerRows.rows.some(({ title }) => title === 'A1 action write')).toBe(true);
    expect(ownerRows.rows.some(({ title }) => title.startsWith('forbidden'))).toBe(false);
    const allowedEvidence = yield* Effect.tryPromise(() =>
      admin.query<{
        evidence_policy_key: string;
        outcome: string;
        query_hash: null;
      }>(
        `select evidence_policy_key, outcome, query_hash from core.data_access_events where tenant_id in ($1, $2) and outcome = 'allowed' order by evidence_policy_key`,
        [tenantA, tenantB],
      ),
    );
    expect(allowedEvidence.rows.length >= 10).toBe(true);
    expect(allowedEvidence.rows.every(({ outcome }) => outcome === 'allowed')).toBe(true);
    expect(allowedEvidence.rows.every(({ query_hash }) => query_hash === null)).toBe(true);
    const unscopedEntityRows = yield* Effect.tryPromise(() =>
      runtimePool.query(`select * from ${schemaName}.entity_records`),
    );
    expect(
      unscopedEntityRows.rowCount,
      'a reused pooled connection must not retain transaction-local scope',
    ).toBe(0);
    const unscopedTenantRows = yield* Effect.tryPromise(() =>
      runtimePool.query(`select * from ${schemaName}.tenant_records`),
    );
    expect(unscopedTenantRows.rowCount).toBe(0);
    expect(capturedLogs.length > 0, 'the generated-owner path must capture runtime logs').toBe(
      true,
    );
    const capturedLogText = capturedLogs.join('\n');
    expect(capturedLogText).toMatch(/Unexpected Action execution defect/u);
    expect(capturedLogText).not.toMatch(
      new RegExp(
        [tenantB, entityA2, entityB1, entityB2, principalB, bindingB, deniedResourceId].join('|'),
        'u',
      ),
    );
    expect(capturedLogText).not.toMatch(
      /postgres|spicedb|row-level|database operation scope|permission check/iu,
    );
    const generatedActionSource = yield* Effect.tryPromise(() =>
      readFile(`${fixture.verticalRoot}/src/actions/create-record.action.ts`, 'utf-8'),
    );
    const generatedServerSource = yield* Effect.tryPromise(() =>
      readFile(`${fixture.verticalRoot}/api/resource-detail-read-server.ts`, 'utf-8'),
    );
    expect(generatedActionSource).toMatch(/@generated by OntOS Codesmith Action/u);
    expect(generatedActionSource).toMatch(/legalEntityScope: 'required'/u);
    expect(generatedServerSource).toMatch(/authenticateOperationPrincipal/u);
    expect(generatedServerSource).toMatch(/makeGovernedReadHttpHandler\(\{/u);
    expect(generatedServerSource).toMatch(/registration: resourceDetailRead/u);
    expect(generatedServerSource).not.toMatch(/yield\* ReadRuntime|\.runRead\(/u);
  }),
);
