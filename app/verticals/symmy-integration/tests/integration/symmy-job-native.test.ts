import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  ActiveApplicationCompositionSnapshotSchema,
  applicationCompositionContentRevision,
  bindManagedApiKeyAction,
  canonicalOntosPublicApiKey,
  extractVerticalRuntimeSafeDescriptors,
  OntosDeploymentIdentitySchema,
  OntosModuleDeploymentContractSchema,
  runAction,
  setManagedApiKeyBindingStatusAction,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/owner-evidence';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '@app/shared-contracts';
import type { GatewayTrustedPrincipalContextSchema } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Array as EffectArray, Context, Effect, Layer, Option, Order, Redacted, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpServer, HttpServerResponse } from 'effect/http';
import { HttpApi } from 'effect/http-api';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';

import {
  AdmitSymmyJobActionAuthenticationProblemSchema,
  AdmitSymmyJobActionForbiddenProblemSchema,
} from '../../shared/apis/admit-symmy-job-action.ts';
import { AdmitSymmyJobBusinessProblemSchema } from '../../shared/domain/admit-symmy-job-business-problems.ts';
import {
  SymmyJobStatusAuthenticationProblemSchema,
  SymmyJobStatusForbiddenProblemSchema,
  SymmyJobStatusNotFoundProblemSchema,
} from '../../shared/apis/symmy-job-status.ts';
import { AdmitSymmyJobPayloadSchema } from '../../shared/actions/admit-symmy-job.ts';
import { SymmyJobIdSchema } from '../../shared/domain/symmy-job-admission.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { executeAdmitSymmyJobWithAuthorization } from '../../src/api/admit-symmy-job-action-client.ts';
import { executeSymmyJobStatusWithAuthorization } from '../../src/api/symmy-job-status-client.ts';
import { symmyIntegrationManifest } from '../../vertical.manifest.ts';
import { symmyIntegrationRegistration } from '../../vertical.registration.ts';

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const audience = 'symmy-integration';
const issuer = 'https://native-symmy-job.ontos.test';
const kid = 'native-symmy-job';
const admitWorkload = 'integration.symmy-admit';
const pollWorkload = 'integration.symmy-poll';
const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const digest = (document: string) => createHash('sha256').update(document).digest('hex');
const identityActionTransport = () => ({
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  targetModuleKey: 'core.identity',
});
const makeComposition = Effect.fn('SymmyJobNative.composition')(function* makeComposition() {
  const { appId, buildMarker } = ultramodernApiMarker;
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([appId], buildMarker);
  const owner = extractVerticalRuntimeSafeDescriptors(symmyIntegrationRegistration);
  const manifest = symmyIntegrationManifest;
  const apis = Object.entries(manifest.publicSurface.api).map(([key, api]) => {
    assert.isOk(HttpApi.isHttpApi(api));
    return {
      key: canonicalOntosPublicApiKey(owner.moduleId, key),
      operationKeys: EffectArray.sort(
        Object.values(api.groups).flatMap((group) =>
          Object.values(group.endpoints).map((endpoint) => `${group.identifier}.${endpoint.identifier}`),
        ),
        Order.String,
      ),
    };
  });
  const contractSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
  const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
    deployment: { appId, buildMarker },
    manifest: {
      activation: manifest.activation,
      module: manifest.module,
      publicSurface: {
        actions: owner.actions,
        api: apis,
        components: [],
        events: [],
        operationContracts: owner.operationContracts,
        reports: [],
        resourceTypes: manifest.publicSurface.resourceTypes,
        search: [],
        shellContributions: owner.shellContributions,
      },
      requirements: owner.requirements,
    },
    runtime: { outboxSubscriptions: owner.outboxSubscriptions },
    schemaVersion: '2',
  });
  const contractDocument = yield* Schema.encodeEffect(contractSchema)(contract);
  const sha256 = digest(contractDocument);
  const composition = {
    ...snapshot.composition,
    modules: snapshot.composition.modules.map((module) => ({
      ...module,
      contract: { ...module.contract, sha256 },
      contractDocument,
      moduleId: owner.moduleId,
      publicContract: { id: owner.moduleId, sha256, version: contract.schemaVersion },
    })),
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...snapshot,
    composition: { ...composition, revision: yield* applicationCompositionContentRevision(composition) },
  });
});

const prepareArtifact = Effect.fn('SymmyJobNative.prepareArtifact')(function* prepareArtifact() {
  const artifact = fileURLToPath(new URL(`../../node_modules/.cache/ontos-1118/${randomUUID()}.mjs`, import.meta.url));
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifact, { force: true })));
  const bundle = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      'exec',
      'esbuild',
      'verticals/symmy-integration/tests/support/symmy-job-receiver.fixture.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--outfile=${artifact}`,
    ],
    { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [status] = yield* Effect.all(
    [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
  return artifact;
});

const migrateOwner = Effect.fn('SymmyJobNative.migrateOwner')(function* migrateOwner(databaseAdminUrl: string) {
  const migration = yield* ChildProcess.make(
    'mise',
    ['exec', '--', 'pnpm', '--filter', '@app/symmy-integration', 'db:migrate'],
    {
      cwd: appRoot,
      env: { APP_ENV_PATH: '/dev/null', DATABASE_ADMIN_URL: databaseAdminUrl },
      extendEnv: true,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [status] = yield* Effect.all(
    [migration.exitCode, Stream.runDrain(migration.stdout), Stream.runDrain(migration.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
});

const seedApiKeyPrincipal = Effect.fn('SymmyJobNative.seedPrincipal')(function* seedApiKeyPrincipal(
  admin: PgClient.PgClient,
  tenantId: string,
  kind: 'integration' | 'service' = 'integration',
) {
  const principalId = randomUUID();
  const bindingId = randomUUID();
  const providerKey = randomUUID();
  yield* admin`insert into core.principals (principal_id, tenant_id, kind, status, display_name)
    values (${principalId}, ${tenantId}, ${kind}, 'active', 'Native Symmy fixture')`;
  yield* admin`insert into core.principal_auth_bindings
    (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type, provider_subject_id, status)
    values (${bindingId}, ${tenantId}, ${principalId}, ${STAFF_AUTHENTICATION_NAMESPACE_ID}, 'better_auth', 'api_key', ${providerKey}, 'active')`;
  return {
    authBindingId: bindingId,
    authContextRef: `better-auth-api-key:${providerKey}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'api_key' as const,
    principalId,
    tenantId,
  };
});

type FixturePrincipal = Effect.Success<ReturnType<typeof seedApiKeyPrincipal>>;
const bindWorkload = (admin: PgClient.PgClient, principal: FixturePrincipal, workload: string) =>
  admin`insert into core.access_workload_bindings (binding_id, incarnation, principal_id, tenant_id, workload_key, status)
    values (${randomUUID()}, ${randomUUID()}, ${principal.principalId}, ${principal.tenantId}, ${workload}, 'active')`;

const ReceiverReady = Schema.Struct({
  marker: OntosDeploymentIdentitySchema,
  port: Schema.Number,
});
const startReceiver = Effect.fn('SymmyJobNative.startReceiver')(function* startReceiver(
  artifact: string,
  databaseUrl: string,
  compositionUrl: string,
  jwks: string,
) {
  const child = yield* ChildProcess.make(process.execPath, [artifact], {
    cwd: appRoot,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_URL: databaseUrl,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: compositionUrl,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: jwks,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const line = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
  assert.isOk(Option.isSome(line));
  const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverReady))(line.value);
  const { appId, buildMarker } = ultramodernApiMarker;
  expect(ready.marker).toEqual({ appId, buildMarker });
  return `http://127.0.0.1:${ready.port}/symmy-integration-api`;
});

const encoded = (json: string) => Buffer.from(json).toString('base64url');
interface AssertionFixtureOptions {
  readonly audience?: string;
  readonly validity?: 'expired';
}

const makeTestIssuer = (admin: PgClient.PgClient, compositionRevision: string) => {
  const pair = generateKeyPairSync('ed25519');
  const jwks = JSON.stringify({
    keys: [{ ...pair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
  });
  const fresh = (
    principal: typeof GatewayTrustedPrincipalContextSchema.Encoded,
    options: AssertionFixtureOptions = {},
  ) =>
    Effect.gen(function* issueTestAssertion() {
      const [row] = yield* admin<{
        epoch: number;
      }>`select floor(extract(epoch from clock_timestamp()))::integer as epoch`;
      assert.isOk(row !== undefined);
      const issuedAt =
        options.validity === 'expired'
          ? row.epoch - GATEWAY_ASSERTION_TTL_SECONDS - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS - 1
          : row.epoch;
      const body = encoded(
        JSON.stringify({
          aud: options.audience ?? audience,
          compositionRevision,
          exp: issuedAt + GATEWAY_ASSERTION_TTL_SECONDS,
          iat: issuedAt,
          iss: issuer,
          jti: randomUUID(),
          principal,
          sub: principal.principalId,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        }),
      );
      const message = `${encoded(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' }))}.${body}`;
      return `Bearer ${message}.${sign(null, Buffer.from(message), pair.privateKey).toString('base64url')}`;
    });
  return { fresh, jwks };
};

it.live(
  'authorizes durable Symmy admission and polling independently across a native receiver restart',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeSymmyJob() {
        const snapshot = yield* makeComposition();
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'implementation-1118-symmy-job-admission',
        });
        yield* isolated.migrateCoreSchema();
        yield* migrateOwner(isolated.connections.admin.connectionString);
        yield* isolated.publishInitialComposition(snapshot);
        const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Effect.provide(Reactivity.layer),
        );
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            access: {
              'core.identity.managed-api-key.bind': 'allowed',
              'core.identity.managed-api-key.change-status': 'allowed',
            },
            actionKeys: [
              bindManagedApiKeyAction.descriptor.actionKey,
              setManagedApiKeyBindingStatusAction.descriptor.actionKey,
            ],
            adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
            allowedAudiences: [audience],
            applicationComposition: { load: Effect.succeed(snapshot) },
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            authenticationSubjectTypes: ['user', 'api_key'],
            compositionRevision: snapshot.composition.revision,
            expectedDeployment: ultramodernApiMarker,
            managerIdentityAdmin: true,
            moduleKeys: ['integration.symmy'],
            ownerRegistration: symmyIntegrationRegistration,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          }),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const submitter = yield* seedApiKeyPrincipal(admin, fixture.tenantId);
        const other = yield* seedApiKeyPrincipal(admin, fixture.tenantId);
        const service = yield* seedApiKeyPrincipal(admin, fixture.tenantId, 'service');
        yield* bindWorkload(admin, submitter, admitWorkload);
        yield* bindWorkload(admin, service, admitWorkload);
        yield* bindWorkload(admin, service, pollWorkload);
        yield* bindWorkload(admin, other, pollWorkload);
        yield* admin`insert into symmy_integration.job_routes
      (tenant_id, principal_id, active, fixture_ids, mapping_version, route_key, route_revision)
      values
            (${fixture.tenantId}, ${submitter.principalId}, true, array['native-products','native-alternate'], '1', 'productsBatch', '1'),
            (${fixture.tenantId}, ${service.principalId}, true, array['native-products'], '1', 'productsBatch', '1')`;

        const artifact = yield* prepareArtifact();
        const testIssuer = makeTestIssuer(admin, snapshot.composition.revision);
        const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
          snapshot,
        );
        const source = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
        yield* source.serve(Effect.succeed(HttpServerResponse.text(document, { contentType: 'application/json' })));
        assert.isOk(Schema.is(Schema.Struct({ port: Schema.Number }))(source.address));
        const compositionUrl = `http://127.0.0.1:${source.address.port}/active-composition`;
        const start = () =>
          startReceiver(artifact, isolated.connections.runtime.connectionString, compositionUrl, testIssuer.jwks);
        const options = (baseUrl: string) => ({ baseUrl, compositionRevision: snapshot.composition.revision });
        const payload = {
          fixtureId: 'native-products',
          idempotencyKey: 'native-client-key',
          routeKey: 'productsBatch',
        } as const;
        const submit = (
          baseUrl: string,
          credential: string,
          command: typeof AdmitSymmyJobPayloadSchema.Encoded = payload,
        ) =>
          executeAdmitSymmyJobWithAuthorization(
            Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(command),
            credential,
            randomUUID(),
            {
              ...options(baseUrl),
              idempotencyKey: randomUUID(),
            },
          );
        const poll = (baseUrl: string, credential: string, jobId: string) =>
          executeSymmyJobStatusWithAuthorization(
            { jobId: SymmyJobIdSchema.make(jobId) },
            credential,
            randomUUID(),
            options(baseUrl),
          );

        const { receipt: accepted, redeemedCredential } = yield* Effect.scoped(
          Effect.gen(function* firstReceiver() {
            const baseUrl = yield* start();
            const wrongAudience = yield* Effect.flip(
              submit(baseUrl, yield* testIssuer.fresh(submitter, { audience: 'another-owner' })),
            );
            expect(Schema.is(AdmitSymmyJobActionAuthenticationProblemSchema)(wrongAudience)).toBe(true);
            const expired = yield* Effect.flip(
              submit(baseUrl, yield* testIssuer.fresh(submitter, { validity: 'expired' })),
            );
            expect(Schema.is(AdmitSymmyJobActionAuthenticationProblemSchema)(expired)).toBe(true);
            const forbidden = yield* Effect.flip(submit(baseUrl, yield* testIssuer.fresh(other)));
            expect(Schema.is(AdmitSymmyJobActionForbiddenProblemSchema)(forbidden)).toBe(true);
            const nonIntegration = yield* Effect.flip(submit(baseUrl, yield* testIssuer.fresh(service)));
            expect(Schema.is(AdmitSymmyJobBusinessProblemSchema)(nonIntegration)).toBe(true);
            expect(nonIntegration).toMatchObject({ code: 'symmy_job_route_denied', status: 403 });
            const unconfigured = yield* Effect.flip(
              submit(baseUrl, yield* testIssuer.fresh(submitter), { ...payload, routeKey: 'customersBatch' }),
            );
            expect(Schema.is(AdmitSymmyJobBusinessProblemSchema)(unconfigured)).toBe(true);
            expect(unconfigured).toMatchObject({ code: 'symmy_job_route_denied', status: 403 });
            const credential = yield* testIssuer.fresh(submitter);
            const receipt = yield* submit(baseUrl, credential);
            expect(receipt).toStrictEqual({ jobId: receipt.jobId, phase: 'admitted' });
            const reused = yield* Effect.flip(submit(baseUrl, credential));
            expect(Schema.is(AdmitSymmyJobActionAuthenticationProblemSchema)(reused)).toBe(true);
            const missingPollBinding = yield* Effect.flip(
              poll(baseUrl, yield* testIssuer.fresh(submitter), receipt.jobId),
            );
            expect(Schema.is(SymmyJobStatusForbiddenProblemSchema)(missingPollBinding)).toBe(true);
            const servicePoll = yield* Effect.flip(poll(baseUrl, yield* testIssuer.fresh(service), receipt.jobId));
            expect(Schema.is(SymmyJobStatusForbiddenProblemSchema)(servicePoll)).toBe(true);
            const foreignJob = yield* Effect.flip(poll(baseUrl, yield* testIssuer.fresh(other), receipt.jobId));
            expect(Schema.is(SymmyJobStatusNotFoundProblemSchema)(foreignJob)).toBe(true);
            return { receipt, redeemedCredential: credential };
          }),
        );
        yield* bindWorkload(admin, submitter, pollWorkload);
        yield* Effect.scoped(
          Effect.gen(function* restartedReceiver() {
            const baseUrl = yield* start();
            const reused = yield* Effect.flip(submit(baseUrl, redeemedCredential));
            expect(Schema.is(AdmitSymmyJobActionAuthenticationProblemSchema)(reused)).toBe(true);
            expect(yield* submit(baseUrl, yield* testIssuer.fresh(submitter))).toStrictEqual(accepted);
            const changed = yield* Effect.flip(
              submit(baseUrl, yield* testIssuer.fresh(submitter), { ...payload, fixtureId: 'native-alternate' }),
            );
            expect(Schema.is(AdmitSymmyJobBusinessProblemSchema)(changed)).toBe(true);
            expect(changed).toMatchObject({ code: 'symmy_job_intent_conflict', status: 409 });
            yield* admin`update symmy_integration.job_routes set active = false
              where tenant_id = ${submitter.tenantId} and principal_id = ${submitter.principalId}
                and route_key = 'productsBatch'`;
            const revoked = yield* Effect.flip(
              submit(baseUrl, yield* testIssuer.fresh(submitter), {
                ...payload,
                idempotencyKey: 'after-route-revocation',
              }),
            );
            expect(Schema.is(AdmitSymmyJobBusinessProblemSchema)(revoked)).toBe(true);
            expect(revoked).toMatchObject({ code: 'symmy_job_route_denied', status: 403 });
            expect(yield* poll(baseUrl, yield* testIssuer.fresh(submitter), accepted.jobId)).toStrictEqual(accepted);
            yield* admin`update symmy_integration.job_routes set active = true
              where tenant_id = ${submitter.tenantId} and principal_id = ${submitter.principalId}
                and route_key = 'productsBatch'`;
            yield* admin`update core.access_workload_bindings set status = 'revoked', revoked_at = clock_timestamp()
              where tenant_id = ${submitter.tenantId} and principal_id = ${submitter.principalId}
                and workload_key = ${admitWorkload}`;
            const revokedWorkload = yield* Effect.flip(
              submit(baseUrl, yield* testIssuer.fresh(submitter), {
                ...payload,
                idempotencyKey: 'after-workload-revocation',
              }),
            );
            expect(Schema.is(AdmitSymmyJobActionForbiddenProblemSchema)(revokedWorkload)).toBe(true);
            expect(yield* poll(baseUrl, yield* testIssuer.fresh(submitter), accepted.jobId)).toStrictEqual(accepted);

            const oldBindingCredential = yield* testIssuer.fresh(submitter);
            const coreContext = yield* Layer.build(fixture.layer);
            const revocation = yield* runAction({
              payload: yield* Schema.decodeEffect(setManagedApiKeyBindingStatusAction.descriptor.payloadSchema)({
                authBindingId: submitter.authBindingId,
                expectedStatus: 'active',
                newStatus: 'revoked',
                principalId: submitter.principalId,
                reason: 'Rotate the native Symmy fixture binding',
              }),
              principal: fixture.manager,
              registration: setManagedApiKeyBindingStatusAction,
              transport: identityActionTransport(),
            }).pipe(Effect.provideContext(coreContext));
            expect(revocation).toStrictEqual({ previousStatus: 'active', status: 'revoked' });
            const providerSubjectId = randomUUID();
            const replacement = yield* runAction({
              payload: yield* Schema.decodeEffect(bindManagedApiKeyAction.descriptor.payloadSchema)({
                principalId: submitter.principalId,
                providerSubjectId,
              }),
              principal: fixture.manager,
              registration: bindManagedApiKeyAction,
              transport: identityActionTransport(),
            }).pipe(Effect.provideContext(coreContext));
            const oldBindingPoll = yield* Effect.flip(poll(baseUrl, oldBindingCredential, accepted.jobId));
            expect(Schema.is(SymmyJobStatusAuthenticationProblemSchema)(oldBindingPoll)).toBe(true);
            expect(oldBindingPoll).toMatchObject({
              status: 401,
              type: 'https://ontos.dev/problems/operation-authentication-required',
            });
            const replacementCredential = yield* testIssuer.fresh({
              ...submitter,
              authBindingId: replacement.authBindingId,
              authContextRef: `better-auth-api-key:${providerSubjectId}`,
            });
            expect(yield* poll(baseUrl, replacementCredential, accepted.jobId)).toStrictEqual(accepted);
          }),
        );
        const [count] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from symmy_integration.import_jobs`;
        expect(count?.count).toBe(1);
      }),
    ).pipe(Effect.provide(nativeServices)),
  120_000,
);
