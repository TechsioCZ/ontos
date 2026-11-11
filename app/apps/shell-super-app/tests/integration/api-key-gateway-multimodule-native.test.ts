import { randomUUID } from 'node:crypto';

import { ActiveApplicationCompositionSnapshotSchema, OntosShellRuntimeContractSchema } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import {
  issueApiKeyGatewayContext,
  issueDelegatedGatewayContext,
} from '@app/shared-contracts/server/gateway-context-api-key';
import {
  GatewayAuthenticationRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayReloadRequiredProblemSchema,
  GatewayContextV2ClaimsSchema,
} from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { createLocalJWKSet, jwtVerify } from 'jose';

import { createShellRuntimeContract } from '../../../../scripts/ontos-shell-runtime-contract.ts';
import {
  ApiKeyGatewayNativeFixtureError,
  ShellNativeGatewayProblemSchema,
  makeApiKeyGatewayNativeComposition,
  makeApiKeyGatewayNativeFixture,
  resolveShellFixtureRelease,
} from '../fixtures/api-key-gateway-native.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const bindUser = Effect.fn('ShellNativeMultiModule.bindUser')(function* bindUser(
  admin: PgClient.PgClient,
  tenantId: string,
  providerUserId: string,
  kind: 'integration' | 'service',
  existingIssuerPrincipalId?: string,
) {
  const issuerPrincipalId = existingIssuerPrincipalId ?? randomUUID();
  const principalId = randomUUID();
  if (existingIssuerPrincipalId === undefined) {
    yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
    values(${issuerPrincipalId},${tenantId},'human','active','Native provider credential issuer')`;
  }
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
    values(${principalId},${tenantId},${kind},'active','Native independent credential fixture')`;
  yield* admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
    values(${randomUUID()},${tenantId},${issuerPrincipalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','user',${providerUserId},'active')`;
  return { issuerPrincipalId, principalId, tenantId };
});
const bindKey = (
  admin: PgClient.PgClient,
  principal: { readonly principalId: string; readonly tenantId: string },
  providerKeyId: string,
) =>
  admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
    values(${randomUUID()},${principal.tenantId},${principal.principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','api_key',${providerKeyId},'active')`;

it.live(
  'mounts the production Shell with separately authenticated module keys and refuses their use as actor keys',
  () =>
    Effect.scoped(
      Effect.gen(function* independentModuleCredentials() {
        // These empty module contracts grant no business operations. This test proves real Shell credential enrollment only.
        const release = yield* resolveShellFixtureRelease();
        const shellContract = createShellRuntimeContract(release.buildMarker);
        const document = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
          shellContract,
        );
        const snapshot = yield* makeApiKeyGatewayNativeComposition(
          [
            makeModuleContractFixture({ appId: 'symmy-integration', moduleId: 'integration.symmy' }),
            makeModuleContractFixture({ appId: 'party-registry', moduleId: 'party.registry' }),
            makeModuleContractFixture({ appId: 'privacy', moduleId: 'privacy.core' }),
            makeModuleContractFixture({ appId: 'catalog', moduleId: 'commerce.catalog' }),
            makeModuleContractFixture({ appId: 'commerce-customer-context', moduleId: 'commerce.customer-context' }),
          ],
          600_000,
          { document, receiverDeployment: shellContract.deployment },
        );
        const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
        const snapshotJson = yield* Schema.encodeEffect(
          Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
        )(snapshot);
        yield* Effect.scoped(
          Effect.gen(function* defaultFixtureAuthenticationRegression() {
            const legacy = yield* makeApiKeyGatewayNativeFixture({ ownedDatabase, snapshotJson });
            const denied = yield* issueApiKeyGatewayContext(
              { audience: 'party-registry', compositionRevision: snapshot.composition.revision },
              {
                apiKey: Redacted.make(''),
                baseUrl: new URL(`${legacy.baseUrl}/shell-super-app-api`),
                requestCorrelation: 'native-default-fixture',
              },
            ).pipe(Effect.flip);
            expect(Schema.is(GatewayAuthenticationRequiredProblemSchema)(denied)).toBe(true);
            expect(legacy.additionalRelaySourceProviderUsers).toEqual([]);
          }),
        );
        const shell = yield* makeApiKeyGatewayNativeFixture({
          additionalRelaySources: [{ sourceAppId: 'party-registry' }, { sourceAppId: 'privacy' }],
          ownedDatabase,
          productionGate: true,
          relaySource: { sourceAppId: 'symmy-integration' },
          snapshotJson,
        });
        const tenantId = randomUUID();
        const tenantSlug = `native-keys-${tenantId}`;
        yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
      values(${tenantId},'Native credential fixture',${tenantSlug},'active','en')`;
        const actor = yield* bindUser(admin, tenantId, shell.providerUserId, 'integration');
        const actorKey = yield* shell.issueFixtureProviderKey(actor);
        yield* bindKey(admin, actor, actorKey.providerKeyId);
        yield* actorKey.acknowledgeBinding;
        const pending = yield* shell
          .issueFixtureSetupGateway({
            audience: 'commerce-market-catalog',
            legalEntityId: '22222222-2222-4222-8222-222222222222',
          })
          .pipe(Effect.flip);
        expect(Schema.is(ApiKeyGatewayNativeFixtureError)(pending)).toBe(true);
        assert.isOk(shell.relaySourceProviderUserId);
        const primary = yield* bindUser(admin, tenantId, shell.relaySourceProviderUserId, 'service');
        const primaryKey = yield* shell.issueFixtureRelaySourceProviderKey(primary);
        yield* bindKey(admin, primary, primaryKey.providerKeyId);
        yield* primaryKey.acknowledgeBinding;
        const credentials = [primaryKey];
        const principals = [primary.principalId];
        for (const source of shell.additionalRelaySourceProviderUsers) {
          const principal = yield* bindUser(admin, tenantId, source.providerUserId, 'service');
          const key = yield* shell.issueFixtureModuleProviderKey({ ...principal, sourceAppId: source.sourceAppId });
          yield* bindKey(admin, principal, key.providerKeyId);
          yield* key.acknowledgeBinding;
          credentials.push(key);
          principals.push(principal.principalId);
        }
        expect(shell.additionalRelaySourceProviderUsers.length).toBe(2);
        expect(new Set(principals).size).toBe(3);
        expect(new Set(credentials.map(({ providerKeyId }) => providerKeyId)).size).toBe(3);
        const issue = (apiKey: Redacted.Redacted) =>
          issueApiKeyGatewayContext(
            {
              audience: 'party-registry',
              compositionRevision: snapshot.composition.revision,
            },
            {
              apiKey,
              baseUrl: new URL(`${shell.baseUrl}/shell-super-app-api`),
              requestCorrelation: 'native-multiple-keys',
            },
          );
        for (const credential of credentials) {
          const denied = yield* issue(credential.secret).pipe(Effect.flip);
          expect(Schema.is(GatewayForbiddenProblemSchema)(denied)).toBe(true);
        }
        const assertion = yield* issue(actorKey.secret);
        expect(assertion.compositionRevision).toBe(snapshot.composition.revision);
        expect(assertion.apiBaseUrl).toContain('/party-registry/');
        const staleRevision = snapshot.composition.revision === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
        const staleRelease = yield* issueApiKeyGatewayContext(
          { audience: 'party-registry', compositionRevision: staleRevision },
          {
            apiKey: actorKey.secret,
            baseUrl: new URL(`${shell.baseUrl}/shell-super-app-api`),
            requestCorrelation: 'native-release-observer-inheritance',
          },
        ).pipe(Effect.flip, Effect.flatMap(Schema.decodeUnknownEffect(GatewayReloadRequiredProblemSchema)));
        expect(staleRelease.status).toBe(409);
        expect(yield* shell.releaseDiagnostics()).toEqual([
          { reason: 'composition_revision_mismatch', stage: 'release' },
        ]);
        const unavailableSetup = yield* shell.issueFixtureSetupGateway({ audience: 'catalog' }).pipe(Effect.flip);
        expect(Schema.is(ApiKeyGatewayNativeFixtureError)(unavailableSetup)).toBe(true);
        const setupKey = yield* shell.issueFixtureSetupActorKey();
        expect('secret' in setupKey).toBe(false);
        yield* bindKey(admin, { principalId: actor.issuerPrincipalId, tenantId }, setupKey.providerKeyId);
        yield* setupKey.acknowledgeBinding;
        const setup = yield* shell.issueFixtureSetupGateway({ audience: 'catalog' });
        const publicKeys = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              keys: Schema.Array(
                Schema.Struct({ crv: Schema.String, kid: Schema.String, kty: Schema.String, x: Schema.String }),
              ),
            }),
          ),
        )(shell.publicJwks);
        const verified = yield* Effect.tryPromise({
          catch: () =>
            new ApiKeyGatewayNativeFixtureError({ reason: 'Native human tenant setup assertion verification failed' }),
          try: async () =>
            await jwtVerify(setup.token, createLocalJWKSet({ keys: [...publicKeys.keys] }), {
              algorithms: ['EdDSA'],
              audience: 'catalog',
              issuer: shell.issuer,
            }),
        });
        const claims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(verified.payload);
        expect(claims.principal.principalId).toBe(actor.issuerPrincipalId);
        expect(claims.principal.authMethod).toBe('api_key');
        expect(claims.principal.legalEntityId).toBeUndefined();
        const governanceLegalEntityId = randomUUID();
        yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
          values(${governanceLegalEntityId},${tenantId},'Native setup governance company','CZ','NATIVE_SETUP','active')`;
        const spiceEnvironment = yield* Config.all({
          SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
          SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
          SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
        });
        yield* grantTestTenantRoleAccess({
          adminConnectionString: Redacted.make(ownedDatabase.connections.admin.connectionString),
          holders: [
            {
              capabilityKeys: ['party.registry.party.read', 'commerce.customer-context.customer-profile.read'],
              principalId: actor.issuerPrincipalId,
            },
          ],
          legalEntityIds: [governanceLegalEntityId],
          spiceDb: yield* liveFixtureSpiceDb(spiceEnvironment),
          tenantId,
        });
        for (const audience of ['party-registry', 'commerce-customer-context'] as const) {
          const scopedSetup = yield* shell.issueFixtureSetupGateway({
            audience,
            legalEntityId: governanceLegalEntityId,
          });
          const scopedVerified = yield* Effect.tryPromise({
            catch: () =>
              new ApiKeyGatewayNativeFixtureError({
                reason: 'Native human company setup assertion verification failed',
              }),
            try: async () =>
              await jwtVerify(scopedSetup.token, createLocalJWKSet({ keys: [...publicKeys.keys] }), {
                algorithms: ['EdDSA'],
                audience,
                issuer: shell.issuer,
              }),
          });
          const scopedClaims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(scopedVerified.payload);
          expect(scopedClaims.principal.principalId).toBe(actor.issuerPrincipalId);
          expect(scopedClaims.principal.authMethod).toBe('session');
          expect(scopedClaims.principal.legalEntityId).toBe(governanceLegalEntityId);
        }
        const declined = yield* issueDelegatedGatewayContext(
          {
            audience: 'privacy',
            compositionRevision: snapshot.composition.revision,
            exchangeId: randomUUID(),
            legalEntityScope: 'tenant',
            subject: { _tag: 'Assertion', sourceAssertion: assertion.token },
          },
          {
            apiKey: primaryKey.secret,
            baseUrl: new URL(`${shell.baseUrl}/shell-super-app-api`),
            requestCorrelation: 'native-wrong-source-assertion',
          },
        ).pipe(Effect.flip);
        const problem = yield* Schema.decodeUnknownEffect(ShellNativeGatewayProblemSchema)(declined);
        expect(yield* shell.gatewayDiagnostics()).toEqual([{ problem: problem._tag, status: problem.status }]);
        for (const duplicate of ['primary', 'additional']) {
          yield* Effect.scoped(
            Effect.gen(function* rejectReusedHumanIssuer() {
              const refused = yield* makeApiKeyGatewayNativeFixture({
                additionalRelaySources: duplicate === 'additional' ? [{ sourceAppId: 'privacy' }] : [],
                ownedDatabase,
                productionGate: true,
                relaySource: { sourceAppId: 'symmy-integration' },
                snapshotJson,
              });
              const original = yield* bindUser(admin, tenantId, refused.providerUserId, 'integration');
              const originalKey = yield* refused.issueFixtureProviderKey(original);
              yield* bindKey(admin, original, originalKey.providerKeyId);
              yield* originalKey.acknowledgeBinding;
              assert.isOk(refused.relaySourceProviderUserId);
              const primaryTarget = yield* bindUser(
                admin,
                tenantId,
                refused.relaySourceProviderUserId,
                'service',
                duplicate === 'primary' ? original.issuerPrincipalId : undefined,
              );
              const issuePrimary = refused.issueFixtureRelaySourceProviderKey(primaryTarget);
              let attempted = issuePrimary;
              if (duplicate === 'additional') {
                const primaryCredential = yield* issuePrimary;
                yield* bindKey(admin, primaryTarget, primaryCredential.providerKeyId);
                yield* primaryCredential.acknowledgeBinding;
                const [additional] = refused.additionalRelaySourceProviderUsers;
                assert.isOk(additional);
                const additionalTarget = yield* bindUser(
                  admin,
                  tenantId,
                  additional.providerUserId,
                  'service',
                  primaryTarget.issuerPrincipalId,
                );
                attempted = refused.issueFixtureModuleProviderKey({
                  ...additionalTarget,
                  sourceAppId: additional.sourceAppId,
                });
              }
              const before = yield* admin`select count(*)::integer as count from auth.apikey`;
              const failure = yield* attempted.pipe(Effect.flip);
              expect(Schema.is(ApiKeyGatewayNativeFixtureError)(failure)).toBe(true);
              const after = yield* admin`select count(*)::integer as count from auth.apikey`;
              expect(after).toEqual(before);
            }),
          );
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);
