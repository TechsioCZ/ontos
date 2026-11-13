import type {
  GatewayContextV2ClaimsSchema,
  GatewayRefusalReason,
  GatewayTrustedPrincipalContextSchema,
} from '@app/shared-contracts';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import {
  OperationContextDenied,
  OperationContextUnavailable,
  PrincipalResolver,
  PrincipalBindingMissingError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateService,
  TenantModuleStateRecordSchema,
} from '@app/core-runtime';
import type { ResolvedPrincipalIdentity } from '@app/core-runtime';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { readVerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { ModuleAppIdSchema } from '@app/core-runtime/auth/hosted-module-credentials';
import { Cause, DateTime, Effect, Exit, Layer, Logger, Option, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { Reactivity } from 'effect/reactivity';
import { SqlClient } from 'effect/sql';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import { GatewayIssuerError, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import {
  GatewayDelegationError,
  delegationForbidden,
  delegationUnavailable,
} from '../../api/auth/gateway-delegation-errors.ts';
import { issueDelegatedGatewayContextAssertion } from '../../api/auth/gateway-delegation-issuer.ts';
import { ModuleCredentialEnrolmentSource } from '../../api/auth/gateway-delegation-policy.ts';
import { makeGatewayDelegationVerificationLayer } from '../../api/auth/gateway-delegation-verification.ts';
import {
  ModuleCredentialBootIdSchema,
  ModuleCredentialHostIdSchema,
} from '../../api/auth/module-credential-attestation.ts';
import { GatewayDelegationExchangeLedger } from '../../api/auth/gateway-delegation-exchanges.service.ts';
import { GatewayDelegationExchangeReplay } from '../../api/auth/gateway-delegation-exchange-replay.ts';
import { GatewayDelegationExchangeUnavailable } from '../../api/auth/gateway-delegation-exchange-unavailable.ts';
import { GatewayOriginatorEvidence } from '../../api/auth/gateway-originator-evidence.ts';
import {
  ShellInstalledModuleCatalog,
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { capturingScopeGrantRegistrar, scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  controlledAuthConnection,
  controlledPgClient,
  delegationUnitIdentity,
  delegationUnitNow,
  delegationUnitPrincipal,
} from '../support/gateway-delegation-test.ts';
import type { DelegationUnitRows } from '../support/gateway-delegation-test.ts';

const issuer = 'https://delegation-unit.example.test';
const subjectInvocationId = '70000000-0000-4000-8000-000000000001';
const sourceKeyId = 'source-workload-key';
const callerIdentity: ResolvedPrincipalIdentity = {
  authBindingId: '10000000-0000-4000-8000-000000000003',
  displayName: 'Catalog module credential',
  principalId: '60000000-0000-4000-8000-000000000001',
  principalKind: 'service',
  tenantId: delegationUnitPrincipal.tenantId,
};

interface DelegationCase {
  /** The release the caller's key was attested for; by default, the release the Shell has installed. */
  readonly attestedRevision?: string;
  readonly authRows?: DelegationUnitRows;
  readonly authUnavailable?: boolean;
  readonly callerKind?: 'human' | 'service';
  readonly catalogRevision?: string;
  readonly catalogUnavailable?: boolean;
  readonly contextFailure?: 'denied' | 'unavailable';
  readonly header?: Partial<Parameters<SignJWT['setProtectedHeader']>[0]>;
  readonly ledgerFailure?: 'replay' | 'unavailable';
  readonly legalEntityScope?: 'subject' | 'tenant';
  readonly malformed?: boolean;
  readonly missingDeployment?: 'catalog' | 'party-registry';
  /** `destination-not-installed`: the calling module is active for the tenant, the module it calls is not. */
  readonly moduleState?:
    | 'suspended'
    | 'quarantined'
    | 'missing'
    | 'unavailable'
    | 'destination-not-installed'
    | 'destination-suspended';
  readonly originalBindingRevoked?: boolean;
  /**
   * `tenant` is a workload requester of work started in the tenant context — the Storefront client — and
   * `person-tenant` a person whose invocation ran there: neither invocation recorded a company.
   */
  readonly originator?: 'ok' | 'denied' | 'unavailable' | 'caller' | 'tenant' | 'person-tenant';
  /** The company an Originator delegation names for that work. */
  readonly originatorLegalEntityId?: string;
  readonly principal?: Partial<typeof GatewayTrustedPrincipalContextSchema.Type>;
  readonly providerKeyId?: string;
  readonly signerUnavailable?: boolean;
  readonly source?: Omit<Partial<typeof GatewayContextV2ClaimsSchema.Encoded>, 'ver'> & {
    readonly act?: unknown;
    readonly ver?: 1 | 2 | 3;
  };
  readonly tamper?: boolean;
  readonly target?: Partial<typeof GatewayDelegatedContextRequestSchema.Encoded>;
  readonly verificationUnavailable?: boolean;
  readonly wrongKey?: boolean;
}

/** The recorded requester of asynchronous work, or the refusal the invocation's evidence would give. */
const originatorEvidenceDouble = (decision: NonNullable<DelegationCase['originator']>) => ({
  load: () => {
    if (decision === 'denied') {
      return Effect.fail(delegationForbidden('originator_not_admitted')());
    }
    if (decision === 'unavailable') {
      return Effect.fail(delegationUnavailable('originator_evidence_unavailable')());
    }
    if (decision === 'caller') {
      return Effect.succeed({
        principal: { ...delegationUnitPrincipal, principalId: callerIdentity.principalId },
        workload: false,
      });
    }
    if (decision === 'tenant' || decision === 'person-tenant') {
      const { legalEntityId: _legalEntityId, ...tenantOnly } = delegationUnitPrincipal;
      return Effect.succeed({ principal: tenantOnly, workload: decision === 'tenant' });
    }
    return Effect.succeed({ principal: delegationUnitPrincipal, workload: false });
  },
});

/** What the scope resolver was asked: the principal it resolved, its company rule and its calling module. */
interface ResolvedScopeRequest {
  readonly actorAppId: string | undefined;
  readonly legalEntityScope: string;
  readonly principal: TrustedPrincipalContext;
}

/** The Current scope resolver, admitting the request unless the case controls a denial or an outage. */
const scopeResolverDouble = (failure: DelegationCase['contextFailure'], requests: ResolvedScopeRequest[]) => ({
  resolve: (request: {
    readonly correlationId: string;
    readonly legalEntityScope: string;
    readonly principal: TrustedPrincipalContext;
  }) => {
    requests.push({
      actorAppId: readVerifiedGatewayActor(request.principal)?.appId,
      legalEntityScope: request.legalEntityScope,
      principal: request.principal,
    });
    if (failure === 'unavailable') {
      return Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Controlled unavailable Current context',
        }),
      );
    }
    if (failure === 'denied') {
      return Effect.fail(
        new OperationContextDenied({
          code: 'operation_context_denied',
          reason: 'Controlled denied Current context',
        }),
      );
    }
    return Effect.succeed({ ...request.principal, correlationId: request.correlationId });
  },
});

/** The module states a case's tenant holds: active unless the case names a missing or unavailable state. */
/** One module's state in a case: every module suspended or quarantined, or only the destination suspended. */
const moduleStateOf = (moduleId: string, moduleState: DelegationCase['moduleState']) => {
  if (moduleState === 'suspended' || moduleState === 'quarantined') {
    return moduleState;
  }
  return moduleState === 'destination-suspended' && moduleId === 'party.registry' ? 'suspended' : 'active';
};

const moduleStatesFor = (
  modules: readonly { readonly moduleId: string }[],
  moduleState: DelegationCase['moduleState'],
) =>
  modules.map((module) =>
    Schema.decodeUnknownSync(TenantModuleStateRecordSchema)({
      moduleKey: module.moduleId,
      state: moduleStateOf(module.moduleId, moduleState),
    }),
  );

/** What the tenant holds: nothing when its states are missing; without the called module when that is not installed. */
const statesHeld = (
  moduleState: DelegationCase['moduleState'],
  states: readonly (typeof TenantModuleStateRecordSchema.Type)[],
) => {
  if (moduleState === 'missing') {
    return [];
  }
  return moduleState === 'destination-not-installed'
    ? states.filter((state) => state.moduleKey !== 'party.registry')
    : states;
};

/** The subject of a case: the requester's own live assertion, or the recorded requester of asynchronous work. */
const subjectFor = (token: string, input: DelegationCase) => {
  if (input.originator === undefined) {
    return { _tag: 'Assertion', sourceAssertion: token };
  }
  const originator = {
    _tag: 'Originator',
    actionInvocationId: subjectInvocationId,
    tenantId: delegationUnitPrincipal.tenantId,
  };
  return input.originatorLegalEntityId === undefined
    ? originator
    : { ...originator, legalEntityId: input.originatorLegalEntityId };
};

/** The catalog module's key as the platform attests it: for the release under test and that release's catalog build. */
const attestedForCatalogBuild = <Credential extends object>(
  credential: Credential,
  installed: {
    readonly composition: { readonly revision: string };
    readonly contracts: readonly { readonly deployment: { readonly appId: string; readonly buildMarker: string } }[];
  },
) => {
  const catalogBuild = installed.contracts.find((contract) => contract.deployment.appId === 'catalog');
  return {
    ...credential,
    attestation:
      catalogBuild === undefined
        ? Option.none()
        : Option.some({
            appId: ModuleAppIdSchema.make('catalog'),
            bootId: ModuleCredentialBootIdSchema.make('00000000-0000-4000-8000-000000000001'),
            buildMarker: catalogBuild.deployment.buildMarker,
            compositionRevision: installed.composition.revision,
            hostId: ModuleCredentialHostIdSchema.make('fixture-host'),
            ontosModuleCredential: 'attested_v2' as const,
          }),
  };
};

/** Controlled authority collaborators are unit fixtures; native tests establish actual Current admission. */
const delegationCase = Effect.fn('DelegationIssuerTest.case')(function* delegationCase(input: DelegationCase = {}) {
  yield* TestClock.setTime(delegationUnitNow * 1000);
  const snapshot = yield* makeCompositionSnapshot([
    makeModuleContractFixture({ appId: 'catalog', moduleId: 'commerce.catalog' }),
    makeModuleContractFixture({ appId: 'party-registry', moduleId: 'party.registry' }),
  ]);
  const { revision } = snapshot.composition;
  const { privateKey, publicKey } = yield* Effect.promise(() =>
    generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
  const source = {
    aud: 'catalog',
    compositionRevision: revision,
    exp: delegationUnitNow + 280,
    iat: delegationUnitNow - 20,
    iss: issuer,
    jti: '80000000-0000-4000-8000-000000000001',
    principal: { ...delegationUnitPrincipal, ...input.principal },
    sub: input.principal?.principalId ?? delegationUnitPrincipal.principalId,
    targetBuildMarker: 'catalog-build',
    ver: 2,
    ...input.source,
  };
  const signingKey =
    input.wrongKey === true ? (yield* Effect.promise(() => generateKeyPair('EdDSA'))).privateKey : privateKey;
  let token = yield* Effect.promise(() =>
    new SignJWT(source)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'delegation-unit', typ: 'JWT', ...input.header })
      .sign(signingKey),
  );
  if (input.tamper === true) {
    const parts = token.split('.');
    token = `${parts[0]}.${parts[1]}.${parts[2]?.startsWith('a') === true ? 'b' : 'a'}${parts[2]?.slice(1)}`;
  }
  if (input.malformed === true) {
    token = 'not-a-jwt';
  }
  const subject = subjectFor(token, input);
  const requestBase = {
    audience: 'party-registry',
    compositionRevision: revision,
    exchangeId: '90000000-0000-4000-8000-000000000001',
    legalEntityScope: input.legalEntityScope ?? 'subject',
    subject,
    ...input.target,
  };
  const payload = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)(requestBase);
  const controlled = controlledAuthConnection(input.authRows ?? [[[true, null]]], input.authUnavailable === true);
  const sql = yield* SqlClient.make({
    acquirer: Effect.succeed(controlled.connection),
    compiler: PgClient.makeCompiler(),
    driver: 'controlled-delegation-unit',
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));
  const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
    Effect.provideService(PgClient.PgClient, controlledPgClient(sql)),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
  let ledgerAttempts = 0;
  let ledgerClaims = 0;
  let signingAttempts = 0;
  const reservedSourceKeys: string[] = [];
  const resolvedScopes: ResolvedScopeRequest[] = [];
  const registrar = capturingScopeGrantRegistrar();
  const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  const catalogEnrolment = {
    appId: 'catalog',
    authBindingId: callerIdentity.authBindingId,
    boundAt: new Date(0),
    principalId: callerIdentity.principalId,
    providerKeyId: sourceKeyId,
  };
  const selectedCatalog = {
    ...installed,
    composition: { ...installed.composition, revision: input.catalogRevision ?? revision },
    contracts: installed.contracts.filter((contract) => contract.deployment.appId !== input.missingDeployment),
  };
  const configuration = yield* parseGatewayIssuerConfig({
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid: 'delegation-unit', use: 'sig' }),
  });
  const signer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(delegationUnitNow),
    generateJti: Effect.sync(() => {
      signingAttempts += 1;
      return 'a0000000-0000-4000-8000-000000000001';
    }),
    loadAdmission: Effect.succeed({ audiences: new Map([['party-registry', 'party-registry-build']]), revision }),
    loadConfig: input.signerUnavailable === true ? parseGatewayIssuerConfig({}) : Effect.succeed(configuration),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer(registrar.registrar)));
  const moduleStates = moduleStatesFor(snapshot.composition.modules, input.moduleState);
  const callerKeyId = input.providerKeyId ?? sourceKeyId;
  const callerKind = input.callerKind ?? 'service';
  const result = yield* Effect.exit(
    issueDelegatedGatewayContextAssertion({
      payload,
      requestCorrelation: 'unit-correlation',
      verifiedProviderKeyId: callerKeyId,
    }).pipe(
      Effect.provide(signer),
      // The Shell verifies its own assertion with its own signing configuration; it holds no separate public key set.
      Effect.provide(
        makeGatewayDelegationVerificationLayer(
          input.verificationUnavailable === true ? parseGatewayIssuerConfig({}) : Effect.succeed(configuration),
        ),
      ),
      // The platform enrolled the catalog module's credential; its binding is derived from the installed release.
      Effect.provideService(ModuleCredentialEnrolmentSource, {
        load: Effect.succeed([catalogEnrolment]),
        // Issued for the catalog build of the release under test, exactly as the platform attests it.
        loadAttested: Effect.succeed([
          attestedForCatalogBuild(catalogEnrolment, {
            composition: { revision: input.attestedRevision ?? selectedCatalog.composition.revision },
            contracts: installed.contracts,
          }),
        ]),
      }),
      Effect.provideService(ShellInstalledModuleCatalog, {
        load:
          input.catalogUnavailable === true
            ? Effect.fail(
                new InstalledModuleCatalogUnavailableError({ reason: 'Controlled current catalog unavailable' }),
              )
            : Effect.succeed(selectedCatalog),
      }),
      Effect.provideService(AuthDatabase, { adapter, executor }),
      Effect.provideService(
        PrincipalResolver,
        makePrincipalResolverDouble({
          resolveBetterAuthApiKey: (keyId) => {
            if (keyId === callerKeyId) {
              return Effect.succeed({ ...callerIdentity, principalKind: callerKind });
            }
            return input.originalBindingRevoked === true
              ? Effect.fail(new PrincipalBindingMissingError())
              : Effect.succeed(delegationUnitIdentity);
          },
        }),
      ),
      Effect.provideService(GatewayOriginatorEvidence, originatorEvidenceDouble(input.originator ?? 'ok')),
      Effect.provideService(OperationalScopeResolver, scopeResolverDouble(input.contextFailure, resolvedScopes)),
      Effect.provide(
        Layer.mock(TenantModuleStateService, {
          getTenantModuleStates: () =>
            input.moduleState === 'unavailable'
              ? Effect.fail(
                  new TenantModuleStateReadUnavailableError({
                    code: 'tenant_module_state_read_unavailable',
                    reason: 'Controlled unavailable module state',
                  }),
                )
              : Effect.succeed(statesHeld(input.moduleState, moduleStates)),
        }),
      ),
      Effect.provideService(GatewayDelegationExchangeLedger, {
        reserve: (reservation) => {
          ledgerAttempts += 1;
          if (input.ledgerFailure === 'replay') {
            return Effect.fail(new GatewayDelegationExchangeReplay({ reason: 'Controlled replay' }));
          }
          if (input.ledgerFailure === 'unavailable') {
            return Effect.fail(
              new GatewayDelegationExchangeUnavailable({
                cause: 'Controlled connection failure',
                reason: 'Controlled unavailable ledger',
              }),
            );
          }
          ledgerClaims += 1;
          reservedSourceKeys.push(reservation.sourceJti);
          return Effect.void;
        },
      }),
    ),
  );
  return {
    ledgerAttempts,
    ledgerClaims,
    publicKey,
    registrarInputs: registrar.inputs,
    reservedSourceKeys,
    resolvedScopes,
    result,
    revision,
    signingAttempts,
  };
});

const assertDenied = (
  result: Effect.Success<ReturnType<typeof delegationCase>>,
  code: GatewayDelegationError['code'],
  ledgerAttempts = 0,
) => {
  expect(Exit.isFailure(result.result)).toBe(true);
  if (Exit.isFailure(result.result)) {
    const failure = Cause.squash(result.result.cause);
    expect(Schema.is(GatewayDelegationError)(failure)).toBe(true);
    if (Schema.is(GatewayDelegationError)(failure)) {
      expect(failure.code).toBe(code);
    }
  }
  expect(result.ledgerAttempts).toBe(ledgerAttempts);
  expect(result.ledgerClaims).toBe(0);
  expect(result.signingAttempts).toBe(0);
  expect(result.registrarInputs).toHaveLength(0);
};

it.effect(
  'acts for a live requester: keeps the requester and its window, and names the calling module as the actor',
  () =>
    Effect.gen(function* validDelegation() {
      const result = yield* delegationCase();
      const exit = result.result;
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) {
        return;
      }
      const verified = yield* Effect.promise(() =>
        jwtVerify(exit.value.token, result.publicKey, {
          audience: 'party-registry',
          currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
          issuer,
        }),
      );
      expect(verified.payload['ver']).toBe(3);
      expect(verified.payload['principal']).toEqual(delegationUnitPrincipal);
      expect(verified.payload['act']).toEqual({
        appId: 'catalog',
        buildMarker: 'catalog-build',
        principalId: callerIdentity.principalId,
      });
      expect(verified.payload.sub).toBe(delegationUnitPrincipal.principalId);
      expect(verified.payload.exp).toBe(delegationUnitNow + 280);
      expect(verified.payload.iat).toBe(delegationUnitNow - 20);
      expect(result.ledgerClaims).toBe(1);
      expect(result.signingAttempts).toBe(1);
      expect(result.registrarInputs).toHaveLength(1);
    }),
);

it.effect('ignores the act of an incoming version 3 assertion and names the calling module as the actor', () =>
  Effect.gen(function* foreignActIgnored() {
    const result = yield* delegationCase({
      source: {
        act: {
          appId: 'commerce-market-catalog',
          buildMarker: 'foreign-build',
          principalId: '60000000-0000-4000-8000-000000000009',
        },
        ver: 3,
      },
    });
    const exit = result.result;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const verified = yield* Effect.promise(() =>
      jwtVerify(exit.value.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
        issuer,
      }),
    );
    expect(verified.payload['ver']).toBe(3);
    expect(verified.payload['act']).toEqual({
      appId: 'catalog',
      buildMarker: 'catalog-build',
      principalId: callerIdentity.principalId,
    });
    expect(result.ledgerClaims).toBe(1);
  }),
);

it.effect('acts for asynchronous work: issues a fresh window for the recorded requester, keyed by its invocation', () =>
  Effect.gen(function* originatorDelegation() {
    const result = yield* delegationCase({ originator: 'ok' });
    const exit = result.result;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const verified = yield* Effect.promise(() =>
      jwtVerify(exit.value.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
        issuer,
      }),
    );
    expect(verified.payload['ver']).toBe(3);
    expect(verified.payload['act']).toEqual({
      appId: 'catalog',
      buildMarker: 'catalog-build',
      principalId: callerIdentity.principalId,
    });
    expect(verified.payload.sub).toBe(delegationUnitPrincipal.principalId);
    expect(verified.payload.iat).toBe(delegationUnitNow);
    expect(verified.payload.exp).toBe(delegationUnitNow + 300);
    expect(result.reservedSourceKeys).toEqual([subjectInvocationId]);
  }),
);

const namedCompany = '30000000-0000-4000-8000-000000000009';

it.effect('names the company of work a workload started in the tenant context, resolved for the calling module', () =>
  Effect.gen(function* originatorNamesCompany() {
    const result = yield* delegationCase({ originator: 'tenant', originatorLegalEntityId: namedCompany });
    const exit = result.result;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const verified = yield* Effect.promise(() =>
      jwtVerify(exit.value.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
        issuer,
      }),
    );
    expect(verified.payload['principal']).toMatchObject({ legalEntityId: namedCompany });
    // The company is admitted only through the scope resolver's company selection, asked for this module call.
    expect(result.resolvedScopes).toEqual([
      expect.objectContaining({
        actorAppId: 'catalog',
        legalEntityScope: 'required',
        principal: expect.objectContaining({ legalEntityId: namedCompany }),
      }),
    ]);
  }),
);

it.effect('refuses a named company the subject may not act in, before any ledger claim or signing', () =>
  Effect.gen(function* refusesUnselectableCompany() {
    const result = yield* delegationCase({
      contextFailure: 'denied',
      originator: 'tenant',
      originatorLegalEntityId: namedCompany,
    });
    assertDenied(result, 'forbidden');
  }),
);

it.effect('refuses any company a person’s tenant-context invocation did not record, before resolving a scope', () =>
  Effect.gen(function* refusesCompanyForPerson() {
    // A calling module could otherwise act for the person in every company the person may select.
    const result = yield* delegationCase({ originator: 'person-tenant', originatorLegalEntityId: namedCompany });
    assertDenied(result, 'forbidden');
    expect(result.resolvedScopes).toEqual([]);
    expect(result.ledgerClaims).toBe(0);
    // Naming no company keeps the person in the tenant context the invocation ran in.
    const unnamed = yield* delegationCase({ legalEntityScope: 'tenant', originator: 'person-tenant' });
    expect(Exit.isSuccess(unnamed.result)).toBe(true);
  }),
);

it.effect('refuses a named company that is not the one the originating invocation ran in', () =>
  Effect.gen(function* refusesOtherCompanyThanRecorded() {
    const result = yield* delegationCase({ originator: 'ok', originatorLegalEntityId: namedCompany });
    assertDenied(result, 'forbidden');
    expect(result.resolvedScopes).toEqual([]);
  }),
);

it.effect('refuses a named company on a tenant-only delegation', () =>
  Effect.gen(function* refusesCompanyOnTenantScope() {
    const result = yield* delegationCase({
      legalEntityScope: 'tenant',
      originator: 'tenant',
      originatorLegalEntityId: namedCompany,
    });
    assertDenied(result, 'forbidden');
    expect(result.resolvedScopes).toEqual([]);
  }),
);

it.effect('resolves every delegated subject with its calling module sealed beside it', () =>
  Effect.gen(function* resolvesWithCallingModule() {
    const relayed = yield* delegationCase({});
    expect(Exit.isSuccess(relayed.result)).toBe(true);
    expect(relayed.resolvedScopes.map(({ actorAppId }) => actorAppId)).toEqual(['catalog']);
    const originated = yield* delegationCase({ originator: 'ok' });
    expect(Exit.isSuccess(originated.result)).toBe(true);
    expect(originated.resolvedScopes.map(({ actorAppId }) => actorAppId)).toEqual(['catalog']);
  }),
);

it.effect("tenant scope issues the context without the subject's Legal Entity", () =>
  Effect.gen(function* tenantScopeDropsLegalEntity() {
    const result = yield* delegationCase({ legalEntityScope: 'tenant' });
    const exit = result.result;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const verified = yield* Effect.promise(() =>
      jwtVerify(exit.value.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
        issuer,
      }),
    );
    expect(verified.payload['principal']).not.toHaveProperty('legalEntityId');
  }),
);

it.effect('tenant scope drops a trusted Storefront together with the Legal Entity it belongs to', () =>
  Effect.gen(function* tenantScopeDropsStorefront() {
    const result = yield* delegationCase({
      legalEntityScope: 'tenant',
      source: { principal: { ...delegationUnitPrincipal, trustedStorefrontId: 'storefront-unit' } },
    });
    const exit = result.result;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const verified = yield* Effect.promise(() =>
      jwtVerify(exit.value.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
        issuer,
      }),
    );
    expect(verified.payload['principal']).not.toHaveProperty('legalEntityId');
    expect(verified.payload['principal']).not.toHaveProperty('trustedStorefrontId');
  }),
);

it.effect("subject scope keeps the subject's Legal Entity", () =>
  Effect.gen(function* subjectScopeKeepsLegalEntity() {
    const result = yield* delegationCase({ legalEntityScope: 'subject' });
    const exit = result.result;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const verified = yield* Effect.promise(() =>
      jwtVerify(exit.value.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
        issuer,
      }),
    );
    expect(verified.payload['principal']).toEqual(delegationUnitPrincipal);
  }),
);

it.effect('subject scope gives a subject without a Legal Entity none', () =>
  Effect.gen(function* subjectWithoutLegalEntity() {
    const { legalEntityId: _legalEntityId, ...withoutLegalEntity } = delegationUnitPrincipal;
    const result = yield* delegationCase({
      legalEntityScope: 'subject',
      source: { principal: withoutLegalEntity },
    });
    const exit = result.result;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    const verified = yield* Effect.promise(() =>
      jwtVerify(exit.value.token, result.publicKey, {
        audience: 'party-registry',
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000)),
        issuer,
      }),
    );
    expect(verified.payload['principal']).not.toHaveProperty('legalEntityId');
  }),
);

const cryptoNegatives: readonly (readonly [string, DelegationCase, GatewayDelegationError['code']])[] = [
  ['malformed', { malformed: true }, 'authentication_required'],
  ['tampered', { tamper: true }, 'authentication_required'],
  ['wrong-signing-key', { wrongKey: true }, 'authentication_required'],
  ['wrong-issuer', { source: { iss: 'https://other.example.test' } }, 'authentication_required'],
  ['wrong-audience', { source: { aud: 'party-registry' } }, 'authentication_required'],
  ['expired', { source: { exp: delegationUnitNow, iat: delegationUnitNow - 300 } }, 'authentication_required'],
  ['future-issued', { source: { exp: delegationUnitNow + 301, iat: delegationUnitNow + 1 } }, 'forbidden'],
  ['unknown-signing-kid', { header: { kid: 'unknown-unit-key' } }, 'authentication_required'],
  ['invalid-source-jti', { source: { jti: 'not-a-uuid' } }, 'forbidden'],
  ['wrong-destination', { target: { audience: 'commerce-market-catalog' } }, 'forbidden'],
  ['missing-current-source', { missingDeployment: 'catalog' }, 'forbidden'],
  ['missing-current-destination', { missingDeployment: 'party-registry' }, 'forbidden'],
  ['wrong-header', { header: { typ: 'other' } }, 'forbidden'],
  ['invalid-subject', { source: { sub: '40000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['extended-trust-interval', { source: { exp: delegationUnitNow + 281 } }, 'forbidden'],
  ['wrong-source-build', { source: { targetBuildMarker: 'old-build' } }, 'forbidden'],
  ['wrong-source-revision', { source: { compositionRevision: 'b'.repeat(64) } }, 'forbidden'],
  ['wrong-target-revision', { target: { compositionRevision: 'b'.repeat(64) } }, 'forbidden'],
  ['unbound-module-credential', { providerKeyId: 'unbound-key' }, 'forbidden'],
  ['human-caller-credential', { callerKind: 'human' }, 'forbidden'],
  ['subject-is-the-calling-module', { principal: { principalId: callerIdentity.principalId } }, 'forbidden'],
  ['changed-principal', { principal: { principalId: '40000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['changed-tenant', { principal: { tenantId: '50000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['changed-binding', { principal: { authBindingId: '10000000-0000-4000-8000-000000000002' } }, 'forbidden'],
  ['changed-auth-reference', { principal: { authContextRef: 'foreign:original-key' } }, 'forbidden'],
  [
    'expired-original-key',
    { authRows: [[[true, DateTime.toDateUtc(DateTime.makeUnsafe(delegationUnitNow * 1000))]]] },
    'forbidden',
  ],
  [
    'version-1-source-without-namespace',
    {
      source: {
        principal: {
          authBindingId: '10000000-0000-4000-8000-000000000001',
          authContextRef: 'better-auth-api-key:original-key',
          authMethod: 'api_key',
          legalEntityId: '30000000-0000-4000-8000-000000000001',
          principalId: '40000000-0000-4000-8000-000000000001',
          tenantId: '50000000-0000-4000-8000-000000000001',
        },
        ver: 1,
      },
    },
    'forbidden',
  ],
  ['revoked-original-binding', { originalBindingRevoked: true }, 'forbidden'],
  ['unavailable-module-state', { moduleState: 'unavailable' }, 'unavailable'],
  ['unavailable-auth-database', { authUnavailable: true }, 'unavailable'],
  ['disabled-original-key', { authRows: [[[false, null]]] }, 'forbidden'],
  ['unavailable-verification', { verificationUnavailable: true }, 'unavailable'],
  ['unavailable-current-catalog', { catalogUnavailable: true }, 'unavailable'],
  ['stale-current-composition', { catalogRevision: 'b'.repeat(64), originator: 'ok' }, 'reload_required'],
  // A key issued for another release (an older or newer host's) binds nothing under the installed one.
  ['key-attested-for-another-release', { attestedRevision: 'c'.repeat(64) }, 'forbidden'],
  ['denied-current-context', { contextFailure: 'denied' }, 'forbidden'],
  ['unavailable-current-context', { contextFailure: 'unavailable' }, 'unavailable'],
  ['suspended-module', { moduleState: 'suspended' }, 'forbidden'],
  ['quarantined-module', { moduleState: 'quarantined' }, 'forbidden'],
  ['missing-module-state', { moduleState: 'missing' }, 'forbidden'],
  // Only this refusal tells the calling module that the module it calls is not installed for the tenant.
  ['destination-not-installed', { moduleState: 'destination-not-installed' }, 'module_not_installed'],
  // Installed but suspended is a plain refusal: the calling module must not read it as "not installed".
  ['destination-suspended', { moduleState: 'destination-suspended' }, 'forbidden'],
  ['originator-denied', { originator: 'denied' }, 'forbidden'],
  ['originator-unavailable', { originator: 'unavailable' }, 'unavailable'],
  ['originator-is-the-calling-module', { originator: 'caller' }, 'forbidden'],
];
// Every refusal names the step that refused it with a stable code; the caller logs it, an operator searches for it.
const refusalReasons: readonly (readonly [string, DelegationCase, GatewayRefusalReason])[] = [
  // The stage failure: the Shell could not read the key it verifies its own source assertion with.
  ['unavailable-verification', { verificationUnavailable: true }, 'verification_keys_unavailable'],
  ['unbound-module-credential', { providerKeyId: 'unbound-key' }, 'module_credential_unbound'],
  ['human-caller-credential', { callerKind: 'human' }, 'caller_not_service'],
  ['wrong-signing-key', { wrongKey: true }, 'subject_assertion_unverified'],
  ['wrong-header', { header: { typ: 'other' } }, 'subject_assertion_malformed'],
  ['wrong-source-build', { source: { targetBuildMarker: 'old-build' } }, 'subject_assertion_not_attested'],
  ['unavailable-auth-database', { authUnavailable: true }, 'subject_authentication_unavailable'],
  ['missing-current-destination', { missingDeployment: 'party-registry' }, 'audience_not_installed'],
  ['missing-current-source', { missingDeployment: 'catalog' }, 'module_credential_unbound'],
  ['unavailable-current-catalog', { catalogUnavailable: true }, 'installed_release_unavailable'],
  ['stale-current-composition', { catalogRevision: 'b'.repeat(64), originator: 'ok' }, 'release_changed'],
  ['originator-is-the-calling-module', { originator: 'caller' }, 'subject_not_delegable'],
  [
    'subject-is-the-calling-module',
    { principal: { principalId: callerIdentity.principalId } },
    'subject_authentication_ended',
  ],
  ['denied-current-context', { contextFailure: 'denied' }, 'scope_refused'],
  ['unavailable-current-context', { contextFailure: 'unavailable' }, 'scope_unavailable'],
  ['unavailable-module-state', { moduleState: 'unavailable' }, 'module_states_unavailable'],
  ['suspended-module', { moduleState: 'suspended' }, 'module_not_active'],
  ['destination-not-installed', { moduleState: 'destination-not-installed' }, 'audience_module_not_installed'],
  ['destination-suspended', { moduleState: 'destination-suspended' }, 'audience_module_not_active'],
  ['originator-denied', { originator: 'denied' }, 'originator_not_admitted'],
  ['originator-unavailable', { originator: 'unavailable' }, 'originator_evidence_unavailable'],
  ['late-ledger-replay', { ledgerFailure: 'replay' }, 'exchange_replayed'],
  ['late-ledger-unavailable', { ledgerFailure: 'unavailable' }, 'exchange_ledger_unavailable'],
];
for (const [label, input, reason] of refusalReasons) {
  it.effect(`names ${reason} when it refuses ${label}`, () =>
    Effect.gen(function* refusalReason() {
      const { result } = yield* delegationCase(input);
      const failure = Exit.isFailure(result) ? Cause.squash(result.cause) : null;
      expect(Schema.is(GatewayDelegationError)(failure) ? failure.reason : null).toBe(reason);
    }),
  );
}

it.effect('writes one warning per refusal with its reason, the calling module and the tenant, and no secret', () =>
  Effect.gen(function* refusalWarning() {
    const entries: string[] = [];
    const logger = Logger.layer([
      Logger.make((options) => {
        entries.push(JSON.stringify(Logger.formatStructured.log(options)));
      }),
    ]);
    const { result } = yield* delegationCase({ contextFailure: 'unavailable' }).pipe(Effect.provide(logger));
    expect(Exit.isFailure(result)).toBe(true);
    const warnings = entries.filter((entry) => entry.includes('gateway delegation refused'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('scope_unavailable');
    expect(warnings[0]).toContain('"callerAppId":"catalog"');
    expect(warnings[0]).toContain(`"subjectTenant":"${delegationUnitPrincipal.tenantId}"`);
    expect(warnings[0]).toContain('"audience":"party-registry"');
    expect(warnings[0]).not.toMatch(/eyJ|Bearer|sourceAssertion/u);
  }),
);

for (const [label, input, code] of cryptoNegatives) {
  it.effect(`rejects ${label} before ledger claim or signing through the actual delegation`, () =>
    Effect.gen(function* deniedDelegation() {
      assertDenied(yield* delegationCase(input), code);
    }),
  );
}
for (const failure of ['replay', 'unavailable'] as const) {
  it.effect(`does not sign when the late ledger rejects with ${failure}`, () =>
    Effect.gen(function* ledgerFailure() {
      assertDenied(
        yield* delegationCase({ ledgerFailure: failure }),
        failure === 'replay' ? 'forbidden' : 'unavailable',
        1,
      );
    }),
  );
}

it.effect('keeps the ledger failure as the cause of a refused or unavailable delegation', () =>
  Effect.gen(function* ledgerFailureCause() {
    for (const [failure, tag] of [
      ['replay', 'GatewayDelegationExchangeReplay'],
      ['unavailable', 'GatewayDelegationExchangeUnavailable'],
    ] as const) {
      const result = yield* delegationCase({ ledgerFailure: failure });
      expect(Exit.isFailure(result.result)).toBe(true);
      if (Exit.isFailure(result.result)) {
        const refusal = Cause.squash(result.result.cause);
        expect(Schema.is(GatewayDelegationError)(refusal)).toBe(true);
        if (Schema.is(GatewayDelegationError)(refusal)) {
          // The span of a refused or 503 delegation keeps the ledger failure it stopped on, never a bare code.
          expect(Predicate.isTagged(refusal.cause, tag)).toBe(true);
        }
      }
    }
  }),
);

it.effect('fails closed in the real destination issuer configuration after reserving the exchange', () =>
  Effect.gen(function* unavailableDestinationSigner() {
    const result = yield* delegationCase({ signerUnavailable: true });
    expect(Exit.isFailure(result.result)).toBe(true);
    if (Exit.isFailure(result.result)) {
      const failure = Cause.squash(result.result.cause);
      expect(Schema.is(GatewayIssuerError)(failure)).toBe(true);
      if (Schema.is(GatewayIssuerError)(failure)) {
        expect(failure.code).toBe('gateway_issuer_unavailable');
        expect(failure.stage).toBe('configuration');
      }
    }
    // Reservation precedes destination issuance; failed signing must not make the slot reusable.
    expect(result.ledgerAttempts).toBe(1);
    expect(result.ledgerClaims).toBe(1);
    expect(result.signingAttempts).toBe(0);
    expect(result.registrarInputs).toHaveLength(0);
  }),
);
