import {
  ActiveApplicationCompositionSnapshotSchema,
  TrustedPrincipalContextSchema,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { publishTestApplicationCompositionAuthority, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  SupportedGatewayContextClaimsSchema,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import { NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { defineEffectBff, dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Predicate, Redacted, Schema } from 'effect';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';

import { makeFinanceBillingApiRuntime } from '../../api/index.ts';
import { financeBillingApiContract } from '../../shared/api.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { financeBillingBackendRegistration } from '../../vertical.runtime-declaration.ts';

const audience = 'finance-billing';
const issuer = 'https://shell.finance-records-read-root.test';
const keyId = 'finance-records-read-root';
const PublicKeySchema = Schema.Struct({ crv: Schema.Literal('Ed25519'), kty: Schema.Literal('OKP'), x: Schema.String });
const PublicKeysSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      ...PublicKeySchema.fields,
      alg: Schema.Literal('EdDSA'),
      kid: Schema.String,
      use: Schema.Literal('sig'),
    }),
  ),
});
const HeaderSchema = Schema.Struct({ alg: Schema.Literal('EdDSA'), kid: Schema.String, typ: Schema.Literal('JWT') });

/** A Shell-shaped issuer: an Ed25519 key, its public JWKS, and EdDSA assertions signed with the platform WebCrypto. */
const makeAssertionIssuer = Effect.fn('FinanceRecordsReadRoot.makeIssuer')(function* makeAssertionIssuer(
  compositionRevision: string,
) {
  const generated = yield* Effect.promise(() =>
    globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
  );
  if (!('privateKey' in generated)) {
    return yield* Effect.die('An Ed25519 key pair is required');
  }
  const publicKey = yield* Schema.decodeUnknownEffect(PublicKeySchema)(
    yield* Effect.promise(() => globalThis.crypto.subtle.exportKey('jwk', generated.publicKey)),
  );
  const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(PublicKeysSchema))({
    keys: [{ ...publicKey, alg: 'EdDSA', kid: keyId, use: 'sig' }],
  });
  const crypto = yield* Crypto.Crypto;
  const issue = Effect.fn('FinanceRecordsReadRoot.issueAssertion')(function* issueAssertion(
    principal: typeof TrustedPrincipalContextSchema.Type,
    sampledAt: DateTime.Utc,
  ) {
    const now = Math.floor(DateTime.toEpochMillis(sampledAt) / 1000);
    const header = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(HeaderSchema))({ alg: 'EdDSA', kid: keyId, typ: 'JWT' }),
    ).toString('base64url');
    const claims = yield* decodeSupportedGatewayContextClaims({
      aud: audience,
      compositionRevision,
      exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
      iat: now,
      iss: issuer,
      jti: yield* crypto.randomUUIDv4(),
      principal,
      sub: principal.principalId,
      targetBuildMarker: ultramodernApiMarker.buildMarker,
      ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
    });
    const payload = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    const signature = yield* Effect.promise(() =>
      globalThis.crypto.subtle.sign('Ed25519', generated.privateKey, new TextEncoder().encode(content)),
    );
    return `${content}.${Buffer.from(signature).toString('base64url')}`;
  });
  return { issue, jwks };
});

type RootHandler = Parameters<typeof dispatchEffectBffRequest>[0];

/** One records read through the actual root's HTTP dispatcher; a dispatcher defect is recorded, never swallowed. */
const postRecordsRead = Effect.fn('FinanceRecordsReadRoot.post')(function* postRecordsRead(
  handler: RootHandler,
  token: string,
  correlationId: string,
) {
  const dispatchErrors: string[] = [];
  const response = yield* Effect.promise(() =>
    dispatchEffectBffRequest(
      handler,
      new Request(`http://localhost${financeBillingApiContract.apiPrefix}/reads/records`, {
        body: '{}',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-correlation-id': `finance-records-read-root-${correlationId}`,
        },
        method: 'POST',
      }),
      {
        onError: (error) => {
          dispatchErrors.push(Predicate.isError(error) ? (error.stack ?? error.message) : String(error));
          return new Response('Unexpected test dispatcher failure', { status: 500 });
        },
        prefix: financeBillingApiContract.apiPrefix,
      },
    ),
  );
  return { body: yield* Effect.promise(() => response.text()), dispatchErrors, status: response.status };
});

it.layer(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer), { excludeTestServices: true, timeout: '180 seconds' })(
  'the actual Finance Billing API root',
  (suite) => {
    suite.effect('answers the records read with the v2 write decision of the apply-command Action, never a 500', () =>
      Effect.gen(function* recordsReadThroughActualRoot() {
        const readKey = recordsRead.descriptor.accessDeclaration?.key;
        const writeKey = applyCommandAction.descriptor.accessDeclaration?.key;
        assert(readKey !== undefined && writeKey !== undefined);
        const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        const { snapshot } = yield* makeOwnerApplicationCompositionFixture({
          appId: ultramodernApiMarker.appId,
          buildMarker: ultramodernApiMarker.buildMarker,
          ownerRegistration: financeBillingBackendRegistration,
        });
        const adminContext = yield* Layer.build(
          PgClient.layer({ maxConnections: 1, url: Redacted.make(connections.admin.connectionString) }).pipe(
            Layer.provideMerge(Reactivity.layer),
          ),
        );
        const adminDatabase = yield* testCoreDatabase.pipe(
          Effect.provideService(PgClient.PgClient, Context.get(adminContext, PgClient.PgClient)),
        );
        yield* publishTestApplicationCompositionAuthority(adminDatabase, snapshot);
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            adminConnectionString: Redacted.make(connections.admin.connectionString),
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: snapshot.composition.revision,
            moduleKeys: [financeBillingBackendRegistration.moduleId],
            ownerRegistration: financeBillingBackendRegistration,
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        // Real v2 roles through the Core access writer: the manager's role holds the records read and the
        // apply-command capability the read asks about, the reader's role only the records read.
        yield* grantTestTenantRoleAccess({
          ...(yield* environmentTestAccessTarget),
          holders: [
            { capabilityKeys: [readKey, writeKey], principalId: fixture.manager.principalId },
            { capabilityKeys: [readKey], principalId: fixture.reader.principalId },
          ],
          legalEntityIds: [fixture.legalEntityId],
          tenantId: fixture.tenantId,
        });

        const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
          snapshot,
        );
        const sourceServer = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
        const sourceAddress = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
          sourceServer.address,
        );
        yield* sourceServer.serve(Effect.sync(() => HttpServerResponse.text(document)));
        const assertionIssuer = yield* makeAssertionIssuer(snapshot.composition.revision);
        // The production root as it deploys: only the configuration the platform hands it is local to this test.
        const provider = ConfigProvider.orElse(
          ConfigProvider.fromEnvRecord({
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${sourceAddress.port}/composition`,
            ONTOS_GATEWAY_ISSUER: issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: assertionIssuer.jwks,
          }),
          yield* ConfigProvider.ConfigProvider,
        );
        const runtime = makeFinanceBillingApiRuntime();
        const handler = yield* Effect.acquireRelease(
          Effect.promise(() =>
            resolveEffectBffModuleHandler(
              {
                default: defineEffectBff({
                  api: runtime.api,
                  layer: runtime.layer.pipe(Layer.provide(ConfigProvider.layer(provider))),
                }),
              },
              {},
            ),
          ).pipe(
            Effect.flatMap((resource) =>
              resource === null ? Effect.die('The actual owner HTTP runtime must resolve') : Effect.succeed(resource),
            ),
          ),
          (resource) =>
            resource.dispose === undefined ? Effect.void : Effect.promise(resource.dispose).pipe(Effect.orDie),
        );

        const readAs = Effect.fn('FinanceRecordsReadRoot.readAs')(function* readAs(actor: typeof fixture.manager) {
          const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
            ...actor,
            legalEntityId: fixture.legalEntityId,
          });
          const token = yield* assertionIssuer.issue(principal, yield* DateTime.now);
          const correlationId = yield* (yield* Crypto.Crypto).randomUUIDv4();
          const { body, dispatchErrors, status } = yield* postRecordsRead(handler.handler, token, correlationId);
          expect(dispatchErrors, body).toEqual([]);
          expect(status, body).toBe(200);
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RecordsResponseSchema))(body);
        });

        expect((yield* readAs(fixture.manager)).canWrite).toBe(true);
        expect((yield* readAs(fixture.reader)).canWrite).toBe(false);
      }).pipe(Effect.scoped),
    );
  },
);
