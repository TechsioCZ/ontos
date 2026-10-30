import { fileURLToPath } from 'node:url';
import {
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  makeActiveApplicationCompositionLayer,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime/modules/active-application-composition';
import { makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/actions';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { Config, Context, Crypto, Effect, Layer, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { assert, expect } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  GatewayAssertionRedemptionLive,
  GatewayAssertionRedemptionDatabaseLive,
} from '../../api/auth/gateway-assertion-redemption.ts';

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Empty owner schemata and physical clone identity are proved by the existing fixed gateways. */
export const preparePartyReconciliationNative = Effect.fn('PartyReconciliation.prepareNative')(
  function* preparePartyReconciliationNative(connections: DatabaseConnectionPair) {
    const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const path = yield* Config.String('PATH');
    assert.isOk(/^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(connections.admin.database));
    expect(connections.admin.database).not.toBe(source.admin.database);
    expect(connections.admin.database).not.toBe(source.runtime.database);
    expect(connections.runtime.database).toBe(connections.admin.database);
    const environment = {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: connections.admin.connectionString,
      DATABASE_URL: connections.runtime.connectionString,
      ONTOS_FIXTURE_OWNED_DATABASE: connections.admin.database,
      ONTOS_FIXTURE_SOURCE_DATABASE: source.admin.database,
      PATH: path,
    };
    const ownerSchema = (phase: 'rebuild' | 'verify', identityEnvironment: Readonly<Record<string, string>>) =>
      Effect.gen(function* runOwnerSchemaPhase() {
        const child = yield* ChildProcess.make(
          'mise',
          [
            'exec',
            '--',
            'pnpm',
            '--filter',
            '@app/party-registry',
            'exec',
            'node',
            'tests/support/current-owner-schema.fixture.ts',
            phase,
          ],
          {
            cwd: appRoot,
            env: { ...environment, ...identityEnvironment },
            extendEnv: false,
            stderr: 'pipe',
            stdout: 'pipe',
          },
        );
        const [code] = yield* Effect.all(
          [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
          { concurrency: 3 },
        );
        expect(code, `Party owner schema ${phase}`).toBe(0);
      });
    yield* ownerSchema('rebuild', {});
    const adminContext = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const admin = Context.get(adminContext, PgClient.PgClient);
    const [row] = yield* admin<{
      readonly databaseName: string;
      readonly databaseOid: string;
      readonly systemIdentifier: string;
      readonly owned: boolean;
    }>`
      select current_database() as "databaseName", d.oid::text as "databaseOid",
      (pg_control_system()).system_identifier::text as "systemIdentifier",
      pg_get_userbyid(d.datdba)=current_user and current_user=session_user as owned
      from pg_database d where d.datname=current_database()`;
    const identity = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        databaseName: Schema.Literal(connections.admin.database),
        databaseOid: Schema.String.check(Schema.isPattern(/^\d+$/u)),
        systemIdentifier: Schema.String.check(Schema.isPattern(/^\d+$/u)),
        owned: Schema.Literal(true),
      }),
    )(row);
    const identityUrls: Record<string, string> = {};
    for (const databaseIdentity of [SHELL_GATEWAY_ISSUER_IDENTITY, PARTY_REGISTRY_REQUEST_IDENTITY]) {
      const canonical = yield* loadDatabaseConfig({ envPath: '/dev/null', identity: databaseIdentity });
      const address = new URL(canonical.connectionString);
      assert.isOk(
        [
          canonical.database === source.admin.database,
          canonical.database === source.runtime.database,
          canonical.host === source.admin.host,
          canonical.port === source.admin.port,
          canonical.host === source.runtime.host,
          canonical.port === source.runtime.port,
          canonical.user === databaseIdentity.role,
          canonical.host === connections.admin.host,
          canonical.port === connections.admin.port,
          connections.runtime.host === connections.admin.host,
          connections.runtime.port === connections.admin.port,
          ['localhost', '127.0.0.1'].includes(canonical.host),
          address.search === '',
          address.hash === '',
        ].every(Boolean),
        'PARTY_RECONCILIATION_IDENTITY_TARGET_REFUSED',
      );
      address.pathname = `/${identity.databaseName}`;
      identityUrls[databaseIdentity.urlKey] = address.href;
    }
    const issuerUrl = identityUrls['SHELL_GATEWAY_ISSUER_DATABASE_URL'];
    const requestUrl = identityUrls['PARTY_REGISTRY_DATABASE_URL'];
    assert.isOk(issuerUrl !== undefined && requestUrl !== undefined);
    const request = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          creatorPid: Schema.Int,
          databaseName: Schema.String,
          databaseOid: Schema.String,
          systemIdentifier: Schema.String,
          type: Schema.Literal('prepare-privacy-native-identities'),
        }),
      ),
    )({
      creatorPid: process.pid,
      databaseName: identity.databaseName,
      databaseOid: identity.databaseOid,
      systemIdentifier: identity.systemIdentifier,
      type: 'prepare-privacy-native-identities',
    });
    const setup = yield* ChildProcess.make(
      process.execPath,
      [`${appRoot}scripts/integration/support/privacy-native-database-identities.mts`, request],
      {
        cwd: appRoot,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: connections.admin.connectionString,
          DATABASE_URL: connections.runtime.connectionString,
          PATH: path,
          ...identityUrls,
        },
        extendEnv: false,
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [lines, code] = yield* Effect.all(
      [
        setup.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        setup.exitCode,
        Stream.runDrain(setup.stderr),
      ],
      { concurrency: 3 },
    );
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          databaseName: Schema.Literal(identity.databaseName),
          databaseOid: Schema.Literal(identity.databaseOid),
          systemIdentifier: Schema.Literal(identity.systemIdentifier),
          type: Schema.Literal('privacy-native-identities-prepared'),
        }),
      ),
    )(lines[0], { onExcessProperty: 'error' });
    yield* ownerSchema('verify', { PARTY_REGISTRY_DATABASE_URL: requestUrl });
    const partyConfiguration = yield* loadDatabaseConfig({
      envPath: '/dev/null',
      identity: PARTY_REGISTRY_REQUEST_IDENTITY,
      environment: { PARTY_REGISTRY_DATABASE_URL: requestUrl },
    });
    const issuerContext = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(issuerUrl) }).pipe(Layer.provideMerge(Reactivity.layer)),
    );
    return { partyConfiguration, issuer: Context.get(issuerContext, PgClient.PgClient) };
  },
);

/** Register the exact signed token; only genuine verification attaches private scope provenance. */
export const makePartyReconciliationGateway = Effect.fn('PartyReconciliation.makeGateway')(
  function* makePartyReconciliationGateway(
    native: { readonly partyConfiguration: DatabaseConnectionPair['runtime']; readonly issuer: PgClient.PgClient },
    composition: ActiveApplicationCompositionSnapshot,
  ) {
    const crypto = yield* Crypto.Crypto;
    const pair = yield* Effect.tryPromise(() => generateKeyPair('Ed25519'));
    const publicJwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));
    const kid = `party-reconciliation-${yield* crypto.randomUUIDv4()}`;
    const issuer = 'https://disposable-shell.ontos.test';
    const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }],
    });
    const registrar = makeGatewayScopeGrantRegistrar(native.issuer);
    const redemptionContext = yield* Layer.build(
      GatewayAssertionRedemptionLive.pipe(
        Layer.provide(GatewayAssertionRedemptionDatabaseLive),
        Layer.provide(Layer.succeed(DatabaseConfig, native.partyConfiguration)),
      ),
    );
    const redemption = Context.get(redemptionContext, GatewayAssertionRedemptionService);
    const compositionContext = yield* Layer.build(makeActiveApplicationCompositionLayer(Effect.succeed(composition)));
    const verifier = bindGatewayPrincipalVerifier('party-registry', ultramodernApiMarker);
    const authorization = Effect.fn('PartyReconciliation.authorization')(function* authorization(
      actor: typeof TrustedPrincipalContextSchema.Type,
    ) {
      const [clock] = yield* native.issuer<{
        readonly nowSeconds: number;
      }>`select floor(extract(epoch from clock_timestamp()))::int as "nowSeconds"`;
      const issuedAt = yield* Schema.decodeUnknownEffect(Schema.Number)(clock?.nowSeconds);
      const expiresAt = issuedAt + GATEWAY_ASSERTION_TTL_SECONDS;
      const jti = yield* crypto.randomUUIDv4();
      const principal = yield* Schema.encodeEffect(TrustedPrincipalContextSchema)(actor);
      const token = yield* Effect.tryPromise(() =>
        new SignJWT({
          compositionRevision: composition.composition.revision,
          principal,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience('party-registry')
          .setSubject(actor.principalId)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .setJti(jti)
          .sign(pair.privateKey),
      );
      const registration = {
        assertion: Redacted.make(token),
        audience: 'party-registry',
        expiresAtEpochSeconds: expiresAt,
        jti,
        principalId: actor.principalId,
        tenantId: actor.tenantId,
      };
      yield* registrar.register(
        actor.legalEntityId === undefined ? registration : { ...registration, legalEntityId: actor.legalEntityId },
      );
      return `Bearer ${token}`;
    });
    const verifyPrincipal = Effect.fn('PartyReconciliation.verifyPrincipal')(function* verifyPrincipal(
      actor: typeof TrustedPrincipalContextSchema.Type,
    ) {
      const bearer = yield* authorization(actor);
      const verified = yield* verifier
        .verifyAndRedeem(Redacted.make(bearer), {
          environment: { ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks },
          redemption,
        })
        .pipe(Effect.provideContext(compositionContext));
      expect(verified.principalId).toBe(actor.principalId);
      expect(verified.tenantId).toBe(actor.tenantId);
      expect(verified.legalEntityId).toBe(actor.legalEntityId);
      return verified;
    });
    return { authorization, verifyPrincipal, issuer, jwks };
  },
);
