import { randomUUID } from 'node:crypto';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Duration, Effect, FileSystem, Layer, Redacted, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';

import {
  internalProductSource,
  makeInternalC14ProductRouteTemplate,
  makeInternalC14ReplayBody,
  productRecordId,
} from './support/symmy-c14-product-plan.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  buildProductWorker,
  c14AppRoot,
  encodeProductComposition,
  nativePortList,
  productComposition,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';

const workerKey = 'integration.symmy.execute-symmy-job';
const catalogModule = 'commerce.catalog';
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const RouteIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyEnrolledRouteId'));
const JobIdSchema = SymmyJobStatusResponseSchema.members[0].fields.jobId;
const ReceiptSchema = Schema.fromJsonString(
  Schema.Struct({ outcome: Schema.Literals(['enrolled', 'unchanged']), routeId: RouteIdSchema }),
);
const AcceptedSchema = Schema.Struct({ jobId: JobIdSchema, status: Schema.Literal('queued') });
const JobSchema = Schema.Struct({ jobId: JobIdSchema, status: Schema.String });
const ProductsSchema = Schema.Struct({
  products: Schema.Array(Schema.Struct({ sourceRecordId: Schema.String.pipe(Schema.brand('SourceRecordId')) })),
});
const terminal: ReadonlySet<string> = new Set([
  'completed_all',
  'completed_partial',
  'completed_none',
  'indeterminate',
  'blocked',
]);

const seedPrincipal = Effect.fn('SymmyC14RouteEnrollment.seedPrincipal')(function* seedPrincipal(
  admin: PgClient.PgClient,
  tenantId: string,
  kind: 'human' | 'integration' | 'service' | 'system',
) {
  const principalId = randomUUID();
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${principalId},${tenantId},${kind},'active','INTERNAL_C14 route enrollment principal')`;
  return { principalId, tenantId };
});
const bindAuth = (
  admin: PgClient.PgClient,
  principal: { readonly principalId: string; readonly tenantId: string },
  subjectType: 'api_key' | 'user',
  providerSubjectId: string,
) =>
  admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
    values(${randomUUID()},${principal.tenantId},${principal.principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth',${subjectType},${providerSubjectId},'active')`;

/** Runs the operator command exactly as an operator does, and returns its receipt or its refusals. */
const runEnrollmentCommand = Effect.fn('SymmyC14RouteEnrollment.command')(function* runCommand(
  environment: Readonly<Record<string, string>>,
  request: Schema.Json,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'INTERNAL_C14_ROUTE_ENROLLMENT_' });
  const requestPath = `${directory}/route.json`;
  yield* fs.writeFileString(requestPath, JSON.stringify(request));
  const child = yield* ChildProcess.make(
    'mise',
    ['exec', '--', 'pnpm', '--silent', 'run', 'ops:route-enrollment', 'apply', '--request', requestPath],
    {
      cwd: `${c14AppRoot}/verticals/symmy-integration`,
      env: environment,
      extendEnv: true,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [exit, output, errors] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(Stream.decodeText(), Stream.runCollect),
      child.stderr.pipe(Stream.decodeText(), Stream.runCollect),
    ],
    { concurrency: 3 },
  );
  const receipt = output.join('').trim().split('\n').at(-1) ?? '';
  if (Number(exit) !== 0) {
    return yield* new SymmyC14ProductFixtureUnavailable({ message: `Route enrollment refused: ${errors.join('')}` });
  }
  return yield* Schema.decodeUnknownEffect(ReceiptSchema)(receipt);
});

it.live(
  'INTERNAL_C14 a fresh Tenant enrolled through the operator command imports one Product through the Shell and reads it back',
  () =>
    Effect.scoped(
      Effect.gen(function* enrolledProductImport() {
        const [catalogPort, symmyPort, marketPort, pricingPort] = yield* nativePortList(4);
        assert.isDefined(catalogPort);
        assert.isDefined(symmyPort);
        assert.isDefined(marketPort);
        assert.isDefined(pricingPort);
        const { contracts, snapshot } = yield* productComposition({
          catalog: `http://127.0.0.1:${catalogPort}/`,
          'commerce-market-catalog': `http://127.0.0.1:${marketPort}/`,
          pricing: `http://127.0.0.1:${pricingPort}/`,
          'symmy-integration': `http://127.0.0.1:${symmyPort}/`,
        });
        const catalog = contracts.find(({ deployment }) => deployment.appId === 'catalog');
        const symmy = contracts.find(({ deployment }) => deployment.appId === 'symmy-integration');
        assert.isOk(catalog);
        assert.isOk(symmy);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
        const shell = yield* makeApiKeyGatewayNativeFixture({
          additionalRelaySources: [
            { sourceAppId: 'party-registry' },
            { sourceAppId: 'commerce-customer-context' },
            { sourceAppId: 'privacy' },
            { sourceAppId: 'pricing' },
          ],
          ownedDatabase: isolated,
          productionGate: true,
          relaySource: { sourceAppId: 'symmy-integration' },
          snapshotJson: yield* encodeProductComposition(snapshot),
        });

        // A fresh Tenant with its company, modules, the Symmy API-key principal and the one system worker.
        const tenantId = randomUUID();
        const slug = `internal-c14-enrollment-${tenantId}`;
        yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale) values(${tenantId},'INTERNAL_C14 route enrollment',${slug},'active','en')`;
        const legalEntityId = randomUUID();
        yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId},${tenantId},'INTERNAL_C14 enrolled company','CZ','INTERNAL_C14','active')`;
        for (const module of snapshot.composition.modules) {
          yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
        }
        const issuer = yield* seedPrincipal(admin, tenantId, 'human');
        yield* bindAuth(admin, issuer, 'user', shell.providerUserId);
        const integration = yield* seedPrincipal(admin, tenantId, 'integration');
        const system = yield* seedPrincipal(admin, tenantId, 'system');
        const integrationWorkloads = [
          'integration.symmy-admit',
          'integration.symmy-poll',
          'commerce.catalog.symmy-product-import',
          'commerce.catalog.symmy-product-read',
          'commerce.catalog.symmy-variant-localized-facts',
          'commerce.pricing.source-write',
          'commerce.market-catalog.source-read',
        ];
        const systemWorkloads = [
          workerKey,
          'commerce.catalog.symmy-product-import',
          'commerce.catalog.symmy-product-read',
          'commerce.catalog.symmy-variant-localized-facts',
          'commerce.catalog.symmy-variant-localized-facts-recovery',
          'commerce.pricing.source-write',
          'commerce.pricing.source-read',
          'commerce.market-catalog.source-read',
        ];
        for (const [principal, workloads] of [
          [integration, integrationWorkloads],
          [system, systemWorkloads],
        ] as const) {
          for (const workload of workloads) {
            yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status) values(${randomUUID()},${randomUUID()},${tenantId},${principal.principalId},${workload},'active')`;
          }
        }
        const key = yield* shell.issueFixtureProviderKey({ ...integration, issuerPrincipalId: issuer.principalId });
        yield* bindAuth(admin, integration, 'api_key', key.providerKeyId);
        yield* key.acknowledgeBinding;
        assert.isOk(shell.relaySourceProviderUserId);
        const moduleIssuer = yield* seedPrincipal(admin, tenantId, 'human');
        yield* bindAuth(admin, moduleIssuer, 'user', shell.relaySourceProviderUserId);
        const modulePrincipal = yield* seedPrincipal(admin, tenantId, 'service');
        const moduleKey = yield* shell.issueFixtureRelaySourceProviderKey({
          ...modulePrincipal,
          issuerPrincipalId: moduleIssuer.principalId,
        });
        yield* bindAuth(admin, modulePrincipal, 'api_key', moduleKey.providerKeyId);
        yield* moduleKey.acknowledgeBinding;

        // The operator enrolls the products route pair through the command; nothing writes the routes otherwise.
        const productsRouteId = randomUUID();
        const productsReadRouteId = randomUUID();
        const sourceRouteId = randomUUID();
        const lifecyclePolicy = { policyId: 'INTERNAL_C14_ENROLLED_PRODUCTS', revision: 'v1' };
        const policies = JSON.stringify([
          {
            ...lifecyclePolicy,
            governanceLegalEntityId: legalEntityId,
            retentionMs: Duration.toMillis(Duration.minutes(1)),
            routeId: productsRouteId,
            targetLegalEntityId: legalEntityId,
            tenantId,
          },
        ]);
        const environment = {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
          ONTOS_GATEWAY_ISSUER: shell.issuer,
          ONTOS_GATEWAY_MODULE_API_KEY: Redacted.value(moduleKey.secret),
          ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
          ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
          ONTOS_SYMMY_JOB_RETENTION_POLICIES: policies,
        };
        const routeRequest = {
          mappingVersion: internalProductSource.mappingVersion,
          principalId: integration.principalId,
          routeRevision: internalProductSource.routeRevision,
          tenantId,
        };
        const productsRoute = {
          ...routeRequest,
          configuration: makeInternalC14ProductRouteTemplate({
            marketId: randomUUID(),
            sourceRouteId,
            unitRef: {
              moduleId: catalogModule,
              resourceId: randomUUID(),
              resourceType: 'commerce.catalog.product-unit',
              tenantId,
            },
          }),
          legalEntityId,
          lifecyclePolicy,
          routeId: productsRouteId,
          routeKey: 'productsBatch',
        };
        const readRoute = {
          ...routeRequest,
          configuration: {
            items: [
              {
                effects: [
                  {
                    effectKey: 'catalog-source-read',
                    operation: {
                      entrypointKey: 'commerce.catalog.api.catalog-source-product-page',
                      moduleId: catalogModule,
                      schemaVersion: '1',
                    },
                  },
                ],
                itemKey: 'source-product-read',
                source: {
                  entityKind: 'PRODUCT',
                  issuerId: internalProductSource.issuerId,
                  sourceNamespace: internalProductSource.namespace,
                  sourceRecordId: productRecordId(internalProductSource.productIdentifier),
                },
              },
            ],
            sourceRouteId,
          },
          routeId: productsReadRouteId,
          routeKey: 'adminProducts',
        };
        expect(yield* runEnrollmentCommand(environment, productsRoute)).toEqual({
          outcome: 'enrolled',
          routeId: productsRouteId,
        });
        expect(yield* runEnrollmentCommand(environment, readRoute)).toEqual({
          outcome: 'enrolled',
          routeId: productsReadRouteId,
        });
        expect(yield* runEnrollmentCommand(environment, productsRoute)).toEqual({
          outcome: 'unchanged',
          routeId: productsRouteId,
        });

        const [catalogArtifacts, symmyArtifacts] = yield* Effect.all([
          buildProductOwner(catalog),
          buildProductOwner(symmy),
        ]);
        yield* startProductOwner({
          artifacts: catalogArtifacts,
          contract: catalog,
          environment,
          port: catalogPort,
          prefix: '/catalog-api',
        });
        const symmyReceiver = yield* startProductOwner({
          artifacts: symmyArtifacts,
          contract: symmy,
          environment,
          port: symmyPort,
          prefix: '/symmy-integration-api',
        });

        // One Product import through the real ingress, executed by the real worker to a terminal job.
        const client = yield* HttpClient.HttpClient;
        const headers = { 'x-api-key': Redacted.value(key.secret) };
        const admitted = yield* client.post(`${shell.baseUrl}/api/symmy/v1/products/batch`, {
          body: yield* HttpBody.json(makeInternalC14ReplayBody()),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_ENROLLED_PRODUCT' },
        });
        if (admitted.status !== 202) {
          yield* new SymmyC14ProductFixtureUnavailable({
            message: `Admission answered ${String(admitted.status)}: ${yield* admitted.text}; Symmy: ${yield* symmyReceiver.diagnostic}`,
          });
        }
        const accepted = yield* admitted.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AcceptedSchema)));
        const worker = yield* startProductWorker(yield* buildProductWorker(symmy), environment);
        const readJob = client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${accepted.jobId}`, { headers }).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(JobSchema)),
        );
        let job = yield* readJob;
        for (let attempt = 0; attempt < 600 && !terminal.has(job.status); attempt += 1) {
          yield* Effect.sleep(Duration.millis(100));
          job = yield* readJob;
        }
        if (!terminal.has(job.status)) {
          yield* new SymmyC14ProductFixtureUnavailable({
            message: `The job stayed ${job.status}; worker: ${yield* worker.diagnostic}`,
          });
        }
        expect(job).toEqual({ jobId: accepted.jobId, status: 'completed_all' });

        const exported = yield* client.get(`${shell.baseUrl}/api/symmy/v1/admin/products`, { headers });
        expect(exported.status).toBe(200);
        const products = yield* exported.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProductsSchema)));
        expect(products.products.map(({ sourceRecordId }) => sourceRecordId)).toEqual([
          productRecordId(internalProductSource.productIdentifier),
        ]);
      }),
    ).pipe(Effect.provide(services)),
  360_000,
);
