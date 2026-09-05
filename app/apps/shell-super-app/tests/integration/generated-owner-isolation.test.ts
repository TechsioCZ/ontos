/* eslint-disable no-await-in-loop, promise/prefer-await-to-callbacks, typescript/no-explicit-any, typescript/no-non-null-assertion, unicorn/consistent-function-scoping, unicorn/no-await-expression-member, unicorn/no-useless-undefined -- One intentionally monolithic live fixture proves the complete generated-owner trust and isolation path. */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
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
  ContextAccessService,
  GatewayAssertionRedemption,
  InstalledModuleCatalog,
  OntosModuleDeploymentContract,
  OperationalScopeResolverService,
  ReadRuntimeService,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { defineEffectBff, HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Layer, Logger, Predicate, Redacted, Schema } from 'effect';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  coreRelations,
  dataAccessEvents,
} from '../../../../packages/core-runtime/src/db/schema.ts';
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
import type { SpiceDbConfigValue } from '../../../../packages/core-runtime/src/permissions/config.ts';
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
import { issueGatewayContextAssertion } from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerConfigValue } from '../../api/auth/gateway-issuer-config.ts';
import {
  ShellGovernedReads,
  createShellGovernedReadsLayer,
} from '../../api/modules/shell-governed-reads.ts';
import { ShellInstalledModuleCatalog } from '../../api/modules/installed-module-catalog.ts';
import {
  ShellProviderUnavailableError,
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

const TEST_SPICEDB: SpiceDbConfigValue = {
  endpoint: process.env['SPICEDB_ENDPOINT'] ?? 'localhost:50051',
  insecureLocal: (process.env['SPICEDB_INSECURE'] ?? 'true') === 'true',
  preSharedKey: Redacted.make(
    process.env['SPICEDB_PRESHARED_KEY'] ?? 'ontos-local-development-key',
  ),
};

const testGatewayAssertionRedemption: GatewayAssertionRedemption = {
  consume: () => Effect.void,
};

interface OwnerHttpHandler {
  readonly dispose: () => Promise<void>;
  readonly handler: (request: Request) => Promise<Response>;
}

const ResourceRefSchema = Schema.Struct({
  moduleId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.String,
});
const OwnerDetailSchema = Schema.Struct({
  fields: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  title: Schema.String,
});
const OwnerTimelineSchema = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      occurredAt: Schema.String,
      summary: Schema.String,
      timelineEntryId: Schema.String,
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
  readonly action: any;
  readonly counts: { action: number; detail: number; list: number; search: number };
  readonly detail: OwnerHttpHandler;
  readonly list: OwnerHttpHandler;
  readonly search: OwnerHttpHandler;
  readonly verifyOperationPrincipal: (
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
  api: any,
  group: Layer.Layer<any, any, any>,
  runtime: ReadRuntimeService,
  loggerLayer: Layer.Layer<never>,
) => {
  const loggedRuntime: ReadRuntimeService = {
    runRead: (input) => runtime.runRead(input).pipe(Effect.provide(loggerLayer)),
  };
  const ownerLayer: any = HttpApiBuilder.layer(api).pipe(
    Layer.provide(group),
    Layer.provide(Layer.succeed(GatewayAssertionRedemptionService, testGatewayAssertionRedemption)),
    Layer.provide(Layer.succeed(ReadRuntime, loggedRuntime)),
    Layer.provide(loggerLayer),
  );
  const bff = defineEffectBff({ api, layer: ownerLayer });
  const handler: OwnerHttpHandler = bff.createHandler();
  return handler;
};

const loadGeneratedOwner = async (
  verticalRoot: string,
  runtime: ReadRuntimeService,
  loggerLayer: Layer.Layer<never>,
): Promise<GeneratedOwnerModules> => {
  const load = async (relativePath: string) =>
    await import(pathToFileURL(`${verticalRoot}/${relativePath}`).href);
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
  ] = await Promise.all([
    load('shared/apis/resource-detail.ts'),
    load('api/resource-detail-read-server.ts'),
    load('shared/apis/resource-list.ts'),
    load('api/resource-list-read-server.ts'),
    load('shared/apis/records-search.ts'),
    load('api/records-search-server.ts'),
    load('api/auth/action-principal.ts'),
    load('src/isolation/instrumentation.ts'),
    load('vertical.registration.ts'),
  ]);
  const registration = registrationOwner.isolationOwnerRegistration;
  const actions = getVerticalRuntimeActions(registration);
  const entrypoints = getVerticalRuntimeEntrypoints(registration);
  const [detailClient, listClient, searchClient] = await Promise.all([
    entrypoints.api['resource-detail']?.(),
    entrypoints.api['resource-list']?.(),
    entrypoints.search['records']?.(),
  ]);
  const generatedAction = actions.find(
    ({ descriptor }) => descriptor.actionKey === GENERATED_OWNER.actionKey,
  );
  if (generatedAction === undefined) {
    throw new TypeError('Generated Action is missing from the owner runtime registration');
  }
  return {
    action: generatedAction,
    counts: state.generatedOwnerHandlerCounts,
    detail: makeOwnerHandler(
      detailApi.ResourceDetailApi,
      detailServer.resourceDetailReadApiLive,
      runtime,
      loggerLayer,
    ),
    list: makeOwnerHandler(
      listApi.ResourceListApi,
      listServer.resourceListReadApiLive,
      runtime,
      loggerLayer,
    ),
    search: makeOwnerHandler(
      searchApi.RecordsSearchApi,
      searchServer.recordsReadApiLive,
      runtime,
      loggerLayer,
    ),
    verifyOperationPrincipal: verifier.verifyOperationPrincipal,
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
};

const requestOwner = async <Payload>(
  handler: OwnerHttpHandler,
  path: string,
  payload: Payload,
  authorization: string,
  correlationId: string,
): Promise<Response> =>
  await handler.handler(
    new Request(`https://isolation-owner.example.test${path}`, {
      body: JSON.stringify(payload),
      headers: {
        authorization,
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
      },
      method: 'POST',
    }),
  );

const decodeResponse = async <ResponseSchema extends Schema.ConstraintDecoder<unknown>>(
  response: Response,
  schema: ResponseSchema,
): Promise<ResponseSchema['Type']> => Schema.decodeUnknownSync(schema)(await response.json());

const createOwnerSchema = async (admin: Pool, schemaName: string): Promise<void> => {
  const tenantPredicate = `tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
  const entityPredicate = `${tenantPredicate} and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  // Dynamic identifiers are generated locally from UUID hex and never accept external input.
  await admin.query(`create schema ${schemaName}`);
  await admin.query(`
    create table ${schemaName}.tenant_records (
      tenant_id uuid not null,
      resource_id uuid not null,
      title text not null,
      primary key (tenant_id, resource_id)
    )
  `);
  await admin.query(`
    create table ${schemaName}.entity_records (
      tenant_id uuid not null,
      legal_entity_id uuid not null,
      resource_id uuid not null,
      title text not null,
      primary key (tenant_id, legal_entity_id, resource_id)
    )
  `);
  for (const [table, predicate] of [
    ['tenant_records', tenantPredicate],
    ['entity_records', entityPredicate],
  ] as const) {
    await admin.query(`alter table ${schemaName}.${table} enable row level security`);
    await admin.query(`alter table ${schemaName}.${table} force row level security`);
    await admin.query(
      `create policy ${table}_select on ${schemaName}.${table} for select to ontos_runtime using (${predicate})`,
    );
    await admin.query(
      `create policy ${table}_insert on ${schemaName}.${table} for insert to ontos_runtime with check (${predicate})`,
    );
    await admin.query(
      `create policy ${table}_update on ${schemaName}.${table} for update to ontos_runtime using (${predicate}) with check (${predicate})`,
    );
    await admin.query(
      `create policy ${table}_delete on ${schemaName}.${table} for delete to ontos_runtime using (${predicate})`,
    );
  }
  await admin.query(`grant usage on schema ${schemaName} to ontos_runtime`);
  await admin.query(
    `grant select, insert, update, delete on all tables in schema ${schemaName} to ontos_runtime`,
  );
};

type CoreDatabaseService = Parameters<typeof makeActionRuntime>[0];

const failingEvidenceDatabase = (database: CoreDatabaseService): CoreDatabaseService => {
  const transactionOverride = {
    transaction: async (callback, configuration) =>
      await database.executor.transaction(async (transaction) => {
        const insert: typeof transaction.insert = (table) => {
          if (Object.is(table, dataAccessEvents)) {
            throw new Error('Injected evidence persistence failure');
          }
          return transaction.insert(table);
        };
        const faultingTransaction: typeof transaction = Object.assign(Object.create(transaction), {
          insert,
        });
        return await callback(faultingTransaction);
      }, configuration),
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

test('Codesmith composes the disposable owner Action and receiving read BFFs', async () => {
  const fixture = await createGeneratedOwnerFixture(
    `generated_owner_${randomUUID().replaceAll('-', '')}`,
  );
  const contract = await deriveOntosModuleDeploymentContract({
    vertical: GENERATED_OWNER.slug,
    workspaceRoot: fixture.root,
  });
  const compileRuntime: ReadRuntimeService = {
    runRead: () => Effect.die(new Error('The compile fixture must not execute a governed read')),
  };
  const generated = await loadGeneratedOwner(
    fixture.verticalRoot,
    compileRuntime,
    capturedLoggerLayer([]),
  );
  try {
    assert.deepEqual(makeCatalog(contract).getByModuleId(GENERATED_OWNER.moduleId), contract);
    assert.equal(generated.action.descriptor.actionKey, GENERATED_OWNER.actionKey);
    assert.equal(generated.action.descriptor.legalEntityScope, 'required');
    assert.deepEqual(generated.counts, { action: 0, detail: 0, list: 0, search: 0 });
    assert.deepEqual(generated.wiring, {
      action: true,
      detailClient: true,
      listClient: true,
      searchClient: true,
    });
  } finally {
    await Promise.allSettled([
      generated.detail.dispose(),
      generated.list.dispose(),
      generated.search.dispose(),
    ]);
    await fixture.dispose();
  }
});

test('generated owner enforces tenant and legal-entity isolation through Shell, BFF, CoreSDK, SpiceDB, and RLS', async () => {
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
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  assert.equal(connections.runtime.user, 'ontos_runtime');
  const admin = new Pool({ connectionString: Redacted.value(connections.admin.connectionString) });
  // Shell and the independently deployed owner hold separate nested read transactions in this
  // in-process fixture, so the shared test pool needs more than one physical connection.
  const runtimePool = new Pool({
    connectionString: Redacted.value(connections.runtime.connectionString),
    max: 4,
  });
  const runtimeDatabase = {
    executor: drizzle({ client: runtimePool, relations: coreRelations }),
  };
  const fixture = await createGeneratedOwnerFixture(schemaName);
  const contract = await deriveOntosModuleDeploymentContract({
    vertical: GENERATED_OWNER.slug,
    workspaceRoot: fixture.root,
  });
  const capturedLogs: string[] = [];
  const loggerLayer = capturedLoggerLayer(capturedLogs);
  const spiceAdmin = v1.NewClient(
    Redacted.value(TEST_SPICEDB.preSharedKey),
    TEST_SPICEDB.endpoint,
    TEST_SPICEDB.insecureLocal
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE,
  );
  const permissionClient = createSpiceDbPermissionClient(TEST_SPICEDB, SPICEDB_CHECK_TIMEOUT_MS);
  const contextAccess = makeContextAccess(permissionClient);
  const moduleStates = makeTenantModuleStateService(runtimeDatabase);
  const moduleStateGate = makeModuleStateGate(moduleStates);
  const moduleGateway = makeModuleEntrypointGateway(moduleStateGate);
  const scopeResolver = makeOperationalScopeResolver(
    makeOperationalScopeRepository(runtimeDatabase),
    contextAccess,
  );
  const readRuntime = makeReadRuntime(runtimeDatabase, moduleGateway, scopeResolver, contextAccess);
  const generated = await loadGeneratedOwner(fixture.verticalRoot, readRuntime, loggerLayer);
  const handlers: OwnerHttpHandler[] = [generated.detail, generated.list, generated.search];
  const keyPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = await exportJWK(keyPair.privateKey);
  const publicJwk = await exportJWK(keyPair.publicKey);
  const issuerConfiguration: GatewayIssuerConfigValue = {
    issuer: 'https://shell.isolation.test',
    privateJwk: {
      alg: 'EdDSA',
      crv: 'Ed25519',
      d: privateJwk.d!,
      kid: 'generated-owner-test',
      kty: 'OKP',
      use: 'sig',
      x: privateJwk.x!,
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
  const previousIssuer = process.env['ONTOS_GATEWAY_ISSUER'];
  const previousJwks = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
  process.env['ONTOS_GATEWAY_ISSUER'] = verifierEnvironment.ONTOS_GATEWAY_ISSUER;
  process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = verifierEnvironment.ONTOS_GATEWAY_PUBLIC_JWKS;
  let assertionCount = 0;
  const issueAuthorization = async (principal: TrustedPrincipalContext) =>
    await Effect.runPromise(
      issueGatewayContextAssertion(
        { audience: GENERATED_OWNER.appId, principal },
        {
          currentTimeSeconds: Effect.sync(() => Math.floor(Date.now() / 1000)),
          generateJti: Effect.sync(() => {
            assertionCount += 1;
            return randomUUID();
          }),
          loadAudiences: Effect.succeed(new Set([GENERATED_OWNER.appId])),
          loadConfig: Effect.succeed(issuerConfiguration),
        },
      ).pipe(Effect.map(({ token }) => `Bearer ${token}`)),
    );
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
  const principalA1 = principal(tenantA, entityA1, principalA, bindingA);
  const principalB1 = principal(tenantB, entityB1, principalB, bindingB);
  const issueProviderAuthorization = async (context: TrustedPrincipalContext) =>
    await issueAuthorization(
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
  const resourceRef = {
    moduleId: GENERATED_OWNER.moduleId,
    resourceId: collidingResourceId,
    resourceType: GENERATED_OWNER.resourceType,
  } as const;
  const touchedObjects: readonly [string, string][] = [
    ['tenant', tenantA],
    ['tenant', tenantB],
    ['legal_entity', toLegalEntityAccessObjectId(tenantA, entityA1)!],
    ['legal_entity', toLegalEntityAccessObjectId(tenantB, entityB1)!],
    ['module_access', toModuleAccessObjectId(tenantA, entityA1, GENERATED_OWNER.moduleId)!],
    ['module_access', toModuleAccessObjectId(tenantB, entityB1, GENERATED_OWNER.moduleId)!],
    ['resource', toResourceAccessObjectId(tenantA, entityA1, resourceRef)!],
    ['resource', toResourceAccessObjectId(tenantB, entityB1, resourceRef)!],
    ['action', toSpiceDbActionObjectId(GENERATED_OWNER.actionKey)],
  ];

  try {
    await createOwnerSchema(admin, schemaName);
    await admin.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $3, 'Generated tenant A', 'active', 'en'), ($2, $4, 'Generated tenant B', 'active', 'en')`,
      [tenantA, tenantB, `generated-a-${tenantA}`, `generated-b-${tenantB}`],
    );
    await admin.query(
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
    );
    await admin.query(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $3, 'human', 'Generated principal A', 'active'), ($2, $4, 'human', 'Generated principal B', 'active')`,
      [principalA, principalB, tenantA, tenantB],
    );
    await admin.query(
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
    );
    await admin.query(
      `insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, $3, 'active'), ($2, $3, 'active')`,
      [tenantA, tenantB, GENERATED_OWNER.moduleId],
    );
    await admin.query(
      `insert into ${schemaName}.tenant_records (tenant_id, resource_id, title) values ($1, $3, 'Tenant A list'), ($2, $3, 'Tenant B list')`,
      [tenantA, tenantB, collidingResourceId],
    );
    await admin.query(
      `insert into ${schemaName}.entity_records (tenant_id, legal_entity_id, resource_id, title) values ($1, $2, $7, 'A1 searchable'), ($1, $3, $7, 'A2 searchable'), ($4, $5, $7, 'B1 searchable'), ($4, $6, $7, 'B2 searchable')`,
      [tenantA, entityA1, entityA2, tenantB, entityB1, entityB2, collidingResourceId],
    );

    const legalA = toLegalEntityAccessObjectId(tenantA, entityA1)!;
    const legalB = toLegalEntityAccessObjectId(tenantB, entityB1)!;
    const moduleA = toModuleAccessObjectId(tenantA, entityA1, GENERATED_OWNER.moduleId)!;
    const moduleB = toModuleAccessObjectId(tenantB, entityB1, GENERATED_OWNER.moduleId)!;
    const resourceA = toResourceAccessObjectId(tenantA, entityA1, resourceRef)!;
    const resourceB = toResourceAccessObjectId(tenantB, entityB1, resourceRef)!;
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
    await spiceAdmin.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: relationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: item,
          }),
        ),
      }),
    );

    const ownerSearchProbe = await requestOwner(
      generated.search,
      `/${GENERATED_OWNER.moduleId}/search/records`,
      { query: 'searchable' },
      await issueAuthorization(principalA1),
      randomUUID(),
    );
    const ownerSearchProbeBody = await decodeResponse(ownerSearchProbe, OwnerSearchSchema);
    assert.equal(ownerSearchProbe.status, 200, JSON.stringify(ownerSearchProbeBody));
    assert.deepEqual(
      ownerSearchProbeBody.map(({ title }) => title),
      ['A1 searchable'],
    );

    const catalog = makeCatalog(contract);
    const gateway = {
      resource: {
        detail: ({ authorization, correlationId, ref }) =>
          Effect.tryPromise({
            catch: () => new ShellProviderUnavailableError(),
            try: async () => {
              const response = await requestOwner(
                generated.detail,
                '/reads/resource-detail',
                { resourceId: ref.resourceId },
                Redacted.value(authorization),
                correlationId,
              );
              if (!response.ok) {
                throw new Error('Owner detail request failed');
              }
              return await decodeResponse(response, OwnerDetailSchema);
            },
          }),
        timeline: ({ authorization, correlationId, ref }) =>
          Effect.tryPromise({
            catch: () => new ShellProviderUnavailableError(),
            try: async () => {
              const response = await requestOwner(
                generated.list,
                '/reads/resource-list',
                { resourceId: ref.resourceId },
                Redacted.value(authorization),
                correlationId,
              );
              if (!response.ok) {
                throw new Error('Owner list request failed');
              }
              return await decodeResponse(response, OwnerTimelineSchema);
            },
          }),
      },
      search: {
        search: ({ authorization, correlationId, query }) =>
          Effect.tryPromise({
            catch: () => new ShellProviderUnavailableError(),
            try: async () => {
              const response = await requestOwner(
                generated.search,
                `/${GENERATED_OWNER.moduleId}/search/records`,
                { query },
                Redacted.value(authorization),
                correlationId,
              );
              if (!response.ok) {
                throw new Error('Owner search request failed');
              }
              return await decodeResponse(response, OwnerSearchSchema);
            },
          }),
      },
    } satisfies ShellResourceGateways;
    assert.deepEqual(
      await Effect.runPromise(
        moduleStates.getTenantModuleStates(tenantA, [GENERATED_OWNER.moduleId]),
      ),
      [{ moduleKey: GENERATED_OWNER.moduleId, state: 'active' }],
    );
    assert.deepEqual(
      await Effect.runPromise(
        contextAccess.modules({
          legalEntityId: entityA1,
          moduleIds: [GENERATED_OWNER.moduleId],
          principalId: principalA,
          tenantId: tenantA,
        }),
      ),
      [{ decision: 'allowed', key: GENERATED_OWNER.moduleId }],
    );
    assert.deepEqual(
      await Effect.runPromise(
        contextAccess.resources({
          legalEntityId: entityA1,
          principalId: principalA,
          resources: [resourceRef],
          tenantId: tenantA,
        }),
      ),
      [
        {
          decision: 'allowed',
          key: `${GENERATED_OWNER.moduleId}:${GENERATED_OWNER.resourceType}:${collidingResourceId}`,
        },
      ],
    );
    assert.deepEqual(
      await Effect.runPromise(
        gateway.search.search({
          appId: GENERATED_OWNER.appId,
          authorization: Redacted.make(await issueAuthorization(principalA1)),
          correlationId: randomUUID(),
          query: 'searchable',
          searchKey: `${GENERATED_OWNER.moduleId}.records`,
        }),
      ),
      [
        {
          ref: resourceRef,
          title: 'A1 searchable',
        },
      ],
    );
    const directShellSearch = makeShellSearch(
      {
        catalog: Effect.succeed(catalog),
        contextAccess,
        issueAssertion: ({ context }) =>
          Effect.tryPromise({
            catch: () => new ShellProviderUnavailableError(),
            try: async () => Redacted.make(await issueProviderAuthorization(context)),
          }),
        moduleStates,
      },
      gateway.search,
    );
    assert.deepEqual(
      await Effect.runPromise(
        directShellSearch.search(
          { ...principalA1, correlationId: randomUUID(), legalEntityId: entityA1 },
          'searchable',
        ),
      ),
      {
        partial: false,
        results: [{ kind: 'resource', ref: resourceRef, title: 'A1 searchable' }],
      },
    );
    const shellLayer = createShellGovernedReadsLayer(
      gateway,
      {
        issueAssertion: ({ context }) =>
          Effect.tryPromise({
            catch: () => new ShellProviderUnavailableError(),
            try: async () => Redacted.make(await issueProviderAuthorization(context)),
          }),
      },
      (transaction) => makeTenantModuleStateService({ executor: transaction }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ReadRuntime, readRuntime),
          Layer.succeed(ContextAccess, contextAccess),
          Layer.succeed(TenantModuleStateService, moduleStates),
          Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        ),
      ),
    );
    const shellReads = await Effect.runPromise(ShellGovernedReads.pipe(Effect.provide(shellLayer)));

    const searchA = await Effect.runPromise(
      shellReads.search({
        correlationId: randomUUID(),
        principal: principalA1,
        query: 'searchable',
      }),
    );
    const detailA = await Effect.runPromise(
      shellReads.resourceDetail({
        correlationId: randomUUID(),
        principal: principalA1,
        ref: resourceRef,
      }),
    );
    const searchB = await Effect.runPromise(
      shellReads.search({
        correlationId: randomUUID(),
        principal: principalB1,
        query: 'searchable',
      }),
    );
    const detailB = await Effect.runPromise(
      shellReads.resourceDetail({
        correlationId: randomUUID(),
        principal: principalB1,
        ref: resourceRef,
      }),
    );
    assert.deepEqual(
      searchA.results.map(({ title }) => title),
      ['A1 searchable'],
    );
    assert.equal(detailA.detail.title, 'A1 searchable');
    assert.deepEqual(
      detailA.timeline.map(({ summary }) => summary),
      ['Tenant A list'],
    );
    assert.deepEqual(
      searchB.results.map(({ title }) => title),
      ['B1 searchable'],
    );
    assert.equal(detailB.detail.title, 'B1 searchable');
    assert.deepEqual(
      detailB.timeline.map(({ summary }) => summary),
      ['Tenant B list'],
    );
    assert.equal(assertionCount, 9, 'every provider attempt must receive a fresh assertion');

    capturedLogs.length = 0;
    const beforeForgedShell = { ...generated.counts };
    await assert.rejects(
      Effect.runPromise(
        shellReads.resourceDetail({
          correlationId: randomUUID(),
          principal: principal(tenantA, entityA2, principalA, bindingA),
          ref: resourceRef,
        }),
      ),
      (error: { readonly _tag?: string }) => error._tag === 'OperationContextDenied',
    );
    await assert.rejects(
      Effect.runPromise(
        shellReads.resourceDetail({
          correlationId: randomUUID(),
          principal: principal(tenantB, entityB1, principalA, bindingA),
          ref: resourceRef,
        }),
      ),
      (error: { readonly _tag?: string }) => error._tag === 'OperationContextDenied',
    );
    assert.deepEqual(generated.counts, beforeForgedShell);
    assert.equal(assertionCount, 9);

    for (const forgedPrincipal of [
      principal(tenantA, entityA2, principalA, bindingA),
      principal(tenantB, entityB1, principalA, bindingA),
    ]) {
      const authorization = await issueAuthorization(forgedPrincipal);
      const response = await requestOwner(
        generated.detail,
        '/reads/resource-detail',
        { resourceId: collidingResourceId },
        authorization,
        randomUUID(),
      );
      assert.equal(response.status, 403);
      const problem = JSON.stringify(await response.json());
      assert.doesNotMatch(
        problem,
        new RegExp([tenantA, tenantB, entityA2, entityB1].join('|'), 'u'),
      );
      assert.doesNotMatch(problem, /postgres|spicedb|permission check|row-level/iu);
    }
    assert.deepEqual(generated.counts, beforeForgedShell);

    const deniedBefore = generated.counts.detail;
    const deniedAuthorization = await issueAuthorization(principalA1);
    const deniedResponse = await requestOwner(
      generated.detail,
      '/reads/resource-detail',
      { resourceId: deniedResourceId },
      deniedAuthorization,
      randomUUID(),
    );
    assert.equal(deniedResponse.status, 403);
    assert.equal(generated.counts.detail, deniedBefore);
    const deniedEvidence = await admin.query<{
      outcome: string;
      outcome_code: string;
      query_hash: null;
      result_count: number;
    }>(
      `select outcome, outcome_code, query_hash, result_count from core.data_access_events where tenant_id = $1 and target_resource_id = $2`,
      [tenantA, deniedResourceId],
    );
    assert.deepEqual(deniedEvidence.rows, [
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
    const unavailableOwner = await loadGeneratedOwner(
      fixture.verticalRoot,
      unavailableRuntime,
      loggerLayer,
    );
    handlers.push(unavailableOwner.detail, unavailableOwner.list, unavailableOwner.search);
    const unavailableBefore = generated.counts.detail;
    const unavailableResponse = await requestOwner(
      unavailableOwner.detail,
      '/reads/resource-detail',
      { resourceId: collidingResourceId },
      await issueAuthorization(principalA1),
      randomUUID(),
    );
    assert.equal(unavailableResponse.status, 503);
    assert.equal(generated.counts.detail, unavailableBefore);
    assert.doesNotMatch(
      JSON.stringify(await unavailableResponse.json()),
      /postgres|spicedb|permission check|row-level/iu,
    );

    const evidenceFailureRuntime = makeReadRuntime(
      failingEvidenceDatabase(runtimeDatabase),
      moduleGateway,
      scopeResolver,
      contextAccess,
    );
    const evidenceFailureOwner = await loadGeneratedOwner(
      fixture.verticalRoot,
      evidenceFailureRuntime,
      loggerLayer,
    );
    handlers.push(
      evidenceFailureOwner.detail,
      evidenceFailureOwner.list,
      evidenceFailureOwner.search,
    );
    const evidenceFailureResponse = await requestOwner(
      evidenceFailureOwner.detail,
      '/reads/resource-detail',
      { resourceId: collidingResourceId },
      await issueAuthorization(principalA1),
      randomUUID(),
    );
    assert.equal(evidenceFailureResponse.status, 503);
    assert.doesNotMatch(JSON.stringify(await evidenceFailureResponse.json()), /A1 searchable/u);

    const actionRuntime = makeActionRuntime(
      runtimeDatabase,
      makeActionRepository(),
      makeActionPermissionService(permissionClient),
      scopeResolver,
      { moduleEntrypointGateway: moduleGateway, moduleStateGate },
    );
    const invokeAction = async (
      trustedPrincipal: TrustedPrincipalContext,
      payload: {
        readonly legalEntityId: string;
        readonly resourceId: string;
        readonly tenantId: string;
        readonly title: string;
      },
      idempotencyKey: string,
    ) => {
      const authorization = await issueAuthorization(trustedPrincipal);
      const verified = await Effect.runPromise(
        generated.verifyOperationPrincipal(authorization, {
          environment: verifierEnvironment,
          redemption: testGatewayAssertionRedemption,
        }),
      );
      return await Effect.runPromise(
        // @ts-expect-error -- Dynamic generated Actions erase private handler-requirement symbols.
        actionRuntime
          .runAction({
            payload,
            principal: verified,
            registration: generated.action,
            transport: {
              correlationId: randomUUID(),
              idempotencyKey,
              targetModuleKey: GENERATED_OWNER.moduleId,
              targetResourceId: payload.resourceId,
              targetResourceType: GENERATED_OWNER.resourceType,
            },
          })
          .pipe(Effect.provide(loggerLayer)),
      );
    };
    const validWriteId = randomUUID();
    assert.deepEqual(
      await invokeAction(
        principalA1,
        {
          legalEntityId: entityA1,
          resourceId: validWriteId,
          tenantId: tenantA,
          title: 'A1 action write',
        },
        randomUUID(),
      ),
      { created: true },
    );
    for (const payload of [
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
    ]) {
      await assert.rejects(
        invokeAction(principalA1, payload, randomUUID()),
        (error: { readonly _tag?: string }) => error._tag === 'CreateRecordRejected',
      );
    }
    const beforeForgedAction = generated.counts.action;
    await assert.rejects(
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
      (error: { readonly _tag?: string }) => error._tag === 'OperationContextDenied',
    );
    assert.equal(generated.counts.action, beforeForgedAction);

    await assert.rejects(
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
      (error: { readonly _tag?: string }) => error._tag === 'ActionHandlerExecutionError',
    );

    const ownerRows = await admin.query<{
      legal_entity_id: string;
      tenant_id: string;
      title: string;
    }>(`select tenant_id, legal_entity_id, title from ${schemaName}.entity_records order by title`);
    assert.equal(
      ownerRows.rows.some(({ title }) => title === 'A1 action write'),
      true,
    );
    assert.equal(
      ownerRows.rows.some(({ title }) => title.startsWith('forbidden')),
      false,
    );

    const allowedEvidence = await admin.query<{
      evidence_policy_key: string;
      outcome: string;
      query_hash: null;
    }>(
      `select evidence_policy_key, outcome, query_hash from core.data_access_events where tenant_id in ($1, $2) and outcome = 'allowed' order by evidence_policy_key`,
      [tenantA, tenantB],
    );
    assert.ok(allowedEvidence.rows.length >= 10);
    assert.equal(
      allowedEvidence.rows.every(({ outcome }) => outcome === 'allowed'),
      true,
    );
    assert.equal(
      allowedEvidence.rows.every(({ query_hash }) => query_hash === null),
      true,
    );

    assert.equal(
      (await runtimePool.query(`select * from ${schemaName}.entity_records`)).rowCount,
      0,
      'a reused pooled connection must not retain transaction-local scope',
    );
    assert.equal(
      (await runtimePool.query(`select * from ${schemaName}.tenant_records`)).rowCount,
      0,
    );

    assert.ok(capturedLogs.length > 0, 'the generated-owner path must capture runtime logs');
    const capturedLogText = capturedLogs.join('\n');
    assert.match(capturedLogText, /Unexpected Action execution defect/u);
    assert.doesNotMatch(
      capturedLogText,
      new RegExp(
        [tenantB, entityA2, entityB1, entityB2, principalB, bindingB, deniedResourceId].join('|'),
        'u',
      ),
    );
    assert.doesNotMatch(
      capturedLogText,
      /postgres|spicedb|row-level|database operation scope|permission check/iu,
    );

    const generatedActionSource = await readFile(
      `${fixture.verticalRoot}/src/actions/create-record.action.ts`,
      'utf-8',
    );
    const generatedServerSource = await readFile(
      `${fixture.verticalRoot}/api/resource-detail-read-server.ts`,
      'utf-8',
    );
    assert.match(generatedActionSource, /@generated by OntOS Codesmith Action/u);
    assert.match(generatedActionSource, /legalEntityScope: 'required'/u);
    assert.match(generatedServerSource, /verifyOperationPrincipal/u);
    assert.match(generatedServerSource, /yield\* ReadRuntime/u);
  } finally {
    if (previousIssuer === undefined) {
      delete process.env['ONTOS_GATEWAY_ISSUER'];
    } else {
      process.env['ONTOS_GATEWAY_ISSUER'] = previousIssuer;
    }
    if (previousJwks === undefined) {
      delete process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
    } else {
      process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = previousJwks;
    }
    await Promise.allSettled(handlers.map(async (handler) => await handler.dispose()));
    for (const [resourceType, resourceId] of touchedObjects.toReversed()) {
      await spiceAdmin.promises
        .deleteRelationships(
          v1.DeleteRelationshipsRequest.create({
            relationshipFilter: v1.RelationshipFilter.create({
              optionalResourceId: resourceId,
              resourceType,
            }),
          }),
        )
        .catch(() => undefined);
    }
    permissionClient.close();
    spiceAdmin.close();
    await admin
      .query('delete from core.outbox_messages where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin
      .query('delete from core.domain_events where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin
      .query('delete from core.data_access_events where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin
      .query('delete from core.audit_events where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin
      .query('delete from core.action_invocations where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin
      .query('delete from core.tenant_module_states where tenant_id in ($1, $2)', [
        tenantA,
        tenantB,
      ])
      .catch(() => undefined);
    await admin
      .query('delete from core.principal_auth_bindings where tenant_id in ($1, $2)', [
        tenantA,
        tenantB,
      ])
      .catch(() => undefined);
    await admin
      .query('delete from core.principals where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin
      .query('delete from core.legal_entities where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin
      .query('delete from core.tenants where tenant_id in ($1, $2)', [tenantA, tenantB])
      .catch(() => undefined);
    await admin.query(`drop schema if exists ${schemaName} cascade`).catch(() => undefined);
    await runtimePool.end();
    await admin.end();
    await fixture.dispose();
  }
});
