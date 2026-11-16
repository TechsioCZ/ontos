import { buildApplicationCompositionCatalog, defineTenantModuleEntrypoint, PrincipalResolver } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { readVerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { GatewayActorClaimSchema } from '@app/shared-contracts';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair } from 'jose';

import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import { GatewayIssuer, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';
import { GatewayDelegationVerification } from '../../api/auth/gateway-delegation-verification.ts';
import {
  admitOrganizationGovernanceRead,
  readAdmittedOrganizationGovernanceRead,
} from '../../api/auth/gateway-organization-governance-evidence.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  controlledAuthConnection,
  controlledPgClient,
  delegationUnitIdentity,
  delegationUnitPrincipal,
} from '../support/gateway-delegation-test.ts';

const now = 1_700_000_000;
const targetKey = 'integration.symmy.api.symmy-source-organization-facts';
const capability = 'integration.symmy.symmy-source-organization-facts.read';
const hash = 'b'.repeat(64);
const issuer = 'https://organization-governance.test';
const fixture = Effect.fn('OrganizationGovernanceTest.fixture')(function* fixture(options: {
  readonly activeHuman?: boolean;
  readonly allowed?: boolean;
  readonly scopeMismatch?: boolean;
  readonly sourceAudience?: 'privacy' | 'party-registry';
  readonly version?: 1 | 2 | 3;
}) {
  yield* TestClock.setTime(now * 1000);
  const source = makeModuleContractFixture({ appId: 'privacy', moduleId: 'privacy.core' });
  const receiver = makeModuleContractFixture({ appId: 'symmy-integration', moduleId: 'integration.symmy' });
  const snapshot = yield* makeCompositionSnapshot([
    source,
    {
      ...receiver,
      manifest: {
        ...receiver.manifest,
        publicSurface: {
          ...receiver.manifest.publicSurface,
          api: [{ key: 'integration.symmy.api.source-facts', operationKeys: ['sourceFacts.execute'] }],
          operationContracts: [
            {
              apiKey: 'integration.symmy.api.source-facts',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'read',
                authorization: { kind: 'protected' },
                entrypointKey: targetKey,
                moduleKey: 'integration.symmy',
                role: 'api',
              }),
              operationKey: 'sourceFacts.execute',
              schemaVersion: '1',
            },
          ],
        },
      },
    },
  ]);
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
  const installed = { ...catalog, composition: snapshot.composition };
  const binding = yield* Schema.decodeUnknownEffect(GatewayModuleBindingSchema)({
    compositionRevision: snapshot.composition.revision,
    providerKeyId: 'privacy-runtime-key',
    sourceAppId: 'privacy',
    sourceBuildMarker: 'privacy-build',
  });
  const { privateKey, publicKey } = yield* Effect.promise(() =>
    generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
  const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
  const { authenticationNamespaceId: _namespace, ...legacyPrincipal } = delegationUnitPrincipal;
  const principal = options.version === 1 ? legacyPrincipal : delegationUnitPrincipal;
  const signer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(now),
    generateJti: Effect.succeed('80000000-0000-4000-8000-000000000001'),
    loadAdmission: Effect.succeed({
      audiences: new Map([
        ['privacy', 'privacy-build'],
        ['party-registry', 'party-build'],
      ]),
      revision: snapshot.composition.revision,
    }),
    loadConfig: Effect.succeed({
      issuer,
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: privateJwk.d ?? '',
        kid: 'source',
        kty: 'OKP',
        use: 'sig',
        x: privateJwk.x ?? '',
      },
    }),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer()));
  const sourceInput = {
    audience: options.sourceAudience ?? 'privacy',
    compositionRevision: snapshot.composition.revision,
    principal,
  };
  const token = yield* Effect.gen(function* issueActualSource() {
    const gateway = yield* GatewayIssuer;
    return yield* gateway.issue(
      options.version === 3
        ? {
            ...sourceInput,
            actor: Schema.decodeUnknownSync(GatewayActorClaimSchema)({
              appId: 'commerce-customer-context',
              buildMarker: 'commerce-build',
              principalId: '60000000-0000-4000-8000-000000000001',
            }),
          }
        : sourceInput,
    );
  }).pipe(Effect.provide(signer));
  const controlled = controlledAuthConnection([[[true, null]]], false);
  const sql = yield* SqlClient.make({
    acquirer: Effect.succeed(controlled.connection),
    compiler: PgClient.makeCompiler(),
    driver: 'organization-governance-auth',
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));
  const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
    Effect.provideService(PgClient.PgClient, controlledPgClient(sql)),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
  let nativeReads = 0;
  const native = testSqlConnection((statement) => {
    if (statement.includes('from core.principals p')) {
      nativeReads += 1;
      return Effect.succeed(options.activeHuman === false ? [] : [{ principal_id: principal.principalId }]);
    }
    return Effect.succeed([]);
  });
  const database = Layer.effect(
    CoreDatabase,
    testCoreDatabase.pipe(Effect.map((coreExecutor) => ({ executor: coreExecutor }))),
  ).pipe(Layer.provide(scriptedPgClientLayer(Effect.succeed(native)).pipe(Layer.provide(Reactivity.layer))));
  const { accessDecision } = makeTestBoundAccessGate({
    answers: { [capability]: { outcome: options.allowed === false ? 'DENIED' : 'ALLOWED' } },
    defaultAnswer: { outcome: 'DENIED' },
  });
  const scopes: TrustedPrincipalContext[] = [];
  const layer = Layer.mergeAll(
    database,
    Layer.succeed(AuthDatabase, { adapter, executor }),
    Layer.succeed(
      PrincipalResolver,
      makePrincipalResolverDouble({ resolveBetterAuthApiKey: () => Effect.succeed(delegationUnitIdentity) }),
    ),
    Layer.succeed(GatewayDelegationVerification, {
      load: Effect.succeed({
        issuer,
        keys: createLocalJWKSet({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'source', use: 'sig' }] }),
      }),
    }),
    Layer.succeed(OperationalScopeResolver, {
      resolve: (input: { readonly correlationId: string; readonly principal: TrustedPrincipalContext }) => {
        scopes.push(input.principal);
        const scope = { ...input.principal, correlationId: input.correlationId };
        return Effect.succeed(
          options.scopeMismatch === true ? { ...scope, legalEntityId: '30000000-0000-4000-8000-000000000009' } : scope,
        );
      },
    }),
    Layer.succeed(AccessDecisionGate, accessDecision),
  );
  const subject = {
    _tag: 'OrganizationGovernanceRead' as const,
    requestHash: hash,
    sourceAssertion: Redacted.make(token.token),
  };
  const input = { audience: 'symmy-integration', binding, installed, subject };
  return { accessDecision, input, layer, nativeReads: () => nativeReads, principal, scopes, token: token.token };
});

it.effect(
  'preserves genuine V2/V3 source identity and interval while asking only actual human governance read rights',
  () =>
    Effect.gen(function* actualHumanSources() {
      const versions: readonly (2 | 3)[] = [2, 3];
      for (const version of versions) {
        const current = yield* fixture({ version });
        const witness = yield* admitOrganizationGovernanceRead(current.input).pipe(Effect.provide(current.layer));
        const admitted = readAdmittedOrganizationGovernanceRead(witness);
        expect(admitted?.principal).toEqual(current.principal);
        expect(admitted?.sourceValidity).toEqual({ expiresAt: now + 300, issuedAt: now });
        expect(admitted?.organizationGovernanceRead).toEqual({
          governanceLegalEntityId: current.principal.legalEntityId,
          principalId: current.principal.principalId,
          requestHash: hash,
          tenantId: current.principal.tenantId,
        });
        expect(current.accessDecision.askedDecisions[0]?.carrier.accessDeclaration?.key).toBe(capability);
        expect(current.accessDecision.askedDecisions[0]?.carrier.accessActor).toBeUndefined();
        expect(readVerifiedGatewayActor(current.accessDecision.askedDecisions[0]?.scope)).toBeUndefined();
        expect(current.nativeReads()).toBe(1);
        if (version === 3) {
          expect(decodeJwt(current.token)['act']).toBeDefined();
        }
        const reflected = Reflect.construct(witness.constructor, [{}, admitted]);
        expect(readAdmittedOrganizationGovernanceRead(reflected)).toBeUndefined();
        const copied = Object.assign(Object.create(Object.getPrototypeOf(witness)), witness);
        expect(readAdmittedOrganizationGovernanceRead(copied)).toBeUndefined();
      }
    }),
);

it.effect('refuses genuine V1 without filling its absent namespace or consulting current authority', () =>
  Effect.gen(function* refuseLegacyMissingNamespace() {
    const current = yield* fixture({ version: 1 });
    expect(decodeJwt(current.token)['ver']).toBe(1);
    expect(
      Exit.isFailure(
        yield* Effect.exit(admitOrganizationGovernanceRead(current.input).pipe(Effect.provide(current.layer))),
      ),
    ).toBe(true);
    expect(current.nativeReads()).toBe(0);
    expect(current.scopes).toHaveLength(0);
  }),
);

it.effect('refuses wrong audience, missing current human facts, denied rights and a mismatched governance scope', () =>
  Effect.gen(function* currentAuthorityControls() {
    yield* Effect.forEach(
      [
        { sourceAudience: 'party-registry' as const },
        { activeHuman: false },
        { allowed: false },
        { scopeMismatch: true },
      ],
      (options) =>
        Effect.gen(function* deniedCase() {
          const current = yield* fixture(options);
          expect(
            Exit.isFailure(
              yield* Effect.exit(admitOrganizationGovernanceRead(current.input).pipe(Effect.provide(current.layer))),
            ),
          ).toBe(true);
        }),
    );
  }),
);
