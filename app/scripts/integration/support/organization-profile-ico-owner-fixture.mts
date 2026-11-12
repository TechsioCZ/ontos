import { OrganizationIcoApplicabilityRequestSchema } from '@app/privacy/api';
import { randomUUID } from 'node:crypto';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import { seedOrganizationProfileIcoNativeFixture } from '@app/commerce-customer-context/testing/organization-profile-ico-native';
import { seedOrganizationMigrationFixture } from '@app/party-registry/testing/organization-migration-native';
import { seedOrganizationIcoNativeFixture } from '@app/privacy/testing/organization-ico-native';
import {
  OrganizationIcoBusinessFieldSchema,
  PrivacyApplicabilityDecisionSchema,
} from '@app/privacy/domain/privacy-applicability';
import { ORGANIZATION_PROFILE_ICO_FIELDS } from '@app/commerce-customer-context/domain/organization-profile-ico';
import { executeRecordPrivacyApplicabilityWithAuthorization } from '@app/privacy/api/client';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, FileSystem, Option, Redacted, Schema } from 'effect';
import {
  bindCustomerFixtureProviderKey,
  seedCustomerFixtureProviderPrincipal,
} from './symmy-c14-customer-native-authority.mts';
import {
  buildProductOwner,
  encodeProductComposition,
  nativePort,
  productComposition,
  startProductOwner,
  SymmyC14ProductFixtureUnavailable,
} from './symmy-c14-product-runtime.mts';

export interface CompanyGovernorInitialization {
  readonly issuer: string;
  readonly publicJwks: string;
  readonly token: string;
}
const purpose = 'implementation-1096-registered-workload-gateway';
const commerceApp = 'commerce-customer-context';
const appIds = ['party-registry', commerceApp, 'privacy'] as const;
const humanCapabilities = [
  'privacy.core.privacy-applicability.record',
  'privacy.core.organization-ico-applicability.read',
  'privacy.core.organization-profile-ico-applicability.read',
  'party.registry.legacy-ico-inventory.read',
  'party.registry.legacy-ico-authority.fence',
  'party.registry.organization-ico-facts.read',
  'party.registry.counterparty-organization-ico-facts.read',
  'commerce.customer-context.customer-profile-organization-ico-facts.read',
  'commerce.customer-context.organization-customer-profile-ico.read',
  'commerce.customer-context.organization-customer-profile-ico.change',
  'commerce.customer-context.organization-customer-profile-ico.migrate',
  'commerce.customer-context.organization-customer-profile-ico-migration.read',
];
const json = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });

/** Setup is explicit preexisting native data. Every applicability decision and subsequent owner
 * operation crosses the genuine public HTTP boundary and uses its production default facts. */
export const makeOrganizationProfileIcoOwnerFixture = Effect.fn('OrganizationProfileIcoHttp.fixture')(
  function* makeOrganizationProfileIcoOwnerFixture(
    initializeGovernor: (
      input: CompanyGovernorInitialization,
    ) => Effect.Effect<TrustedPrincipalContext, SymmyC14ProductFixtureUnavailable>,
  ) {
    const ports = new Map<string, number>();
    for (const appId of appIds) {
      let port = yield* nativePort;
      while ([...ports.values()].includes(port)) {
        port = yield* nativePort;
      }
      ports.set(appId, port);
    }
    const { contracts, snapshot } = yield* productComposition(
      Object.fromEntries([...ports].map(([appId, port]) => [appId, `http://127.0.0.1:${port}/`])),
    );
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: snapshot,
      mode: 'schema-only',
      purpose,
    });
    const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
    const shell = yield* makeApiKeyGatewayNativeFixture({
      additionalRelaySources: appIds.filter((appId) => appId !== commerceApp).map((sourceAppId) => ({ sourceAppId })),
      ownedDatabase: isolated,
      productionGate: true,
      relaySource: { sourceAppId: commerceApp },
      snapshotJson: yield* encodeProductComposition(snapshot),
    });
    const tenantId = randomUUID();
    const legalEntityId = randomUUID();
    const tenantSlug = `ico-${tenantId}`;
    yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
      values(${tenantId},'INTERNAL company ICO fixture',${tenantSlug},'active','en')`;
    yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
      values(${legalEntityId},${tenantId},'INTERNAL company ICO governance','CZ','INTERNAL_ONLY','active')`;
    const integration = yield* seedCustomerFixtureProviderPrincipal(
      admin,
      tenantId,
      'integration',
      shell.providerUserId,
    );
    const human = { principalId: integration.issuerPrincipalId, tenantId };
    for (const module of snapshot.composition.modules) {
      yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
    }
    yield* grantTestTenantRoleAccess({
      holders: [{ capabilityKeys: humanCapabilities, principalId: human.principalId }],
      legalEntityIds: [legalEntityId],
      spiceDb: yield* loadSpiceDbConfig({ envPath: '/dev/null' }),
      tenantId,
      writerConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    });
    const key = yield* shell.issueFixtureProviderKey(integration);
    yield* bindCustomerFixtureProviderKey(admin, integration, key.providerKeyId);
    yield* key.acknowledgeBinding;
    // Each owner's own module key, provisioned by the platform for its module principal as on every environment.
    const moduleKeys = new Map<string, Redacted.Redacted>([
      [commerceApp, (yield* shell.provisionRelaySource()).secret],
    ]);
    for (const appId of appIds) {
      if (appId !== commerceApp) {
        moduleKeys.set(appId, (yield* shell.provisionModuleSource(appId)).secret);
      }
    }
    const gateway = yield* shell.issueFixtureSetupGateway({ audience: 'privacy', legalEntityId });
    const principal = yield* initializeGovernor({
      issuer: shell.issuer,
      publicJwks: shell.publicJwks,
      token: gateway.token,
    });
    if (
      principal.principalId !== human.principalId ||
      principal.tenantId !== tenantId ||
      principal.legalEntityId !== legalEntityId ||
      principal.authMethod !== 'session'
    ) {
      return yield* unavailable('The actual fixture governor is not the selected-company human');
    }
    const parties: Effect.Success<ReturnType<typeof seedOrganizationMigrationFixture>>[] = [];
    const profiles: Effect.Success<ReturnType<typeof seedOrganizationProfileIcoNativeFixture>>[] = [];
    const governance: Effect.Success<ReturnType<typeof seedOrganizationIcoNativeFixture>>[] = [];
    for (const originalInput of [{ digits: '19', kind: 'KNOWN' }, { kind: 'UNKNOWN' }] as const) {
      const party = yield* seedOrganizationMigrationFixture({
        connections: isolated.connections,
        originalInput,
        ownedDatabase: isolated,
        principal,
        purpose,
      });
      parties.push(party);
      const profileRef = yield* seedOrganizationProfileIcoNativeFixture({
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        counterpartyRef: party.counterpartyRef,
        legalEntityId,
        operatorPrincipalId: human.principalId,
        operatorProviderUserId: shell.providerUserId,
        ownedDatabase: isolated,
      });
      profiles.push(profileRef);
      governance.push(
        yield* seedOrganizationIcoNativeFixture({
          callers: [{ authMethod: 'session', principalId: human.principalId }],
          connections: isolated.connections,
          governancePrincipalId: human.principalId,
          legalEntityId,
          ownedDatabase: isolated,
          purpose,
          target: {
            expectedRevision: party.partyRevision,
            kind: 'PARTY',
            request: yield* Schema.decodeUnknownEffect(OrganizationIcoApplicabilityRequestSchema)({
              fields: OrganizationIcoBusinessFieldSchema.literals,
              operation: 'party-ico-legacy-inventory.read',
              partyRef: party.partyRef,
            }),
          },
          tenantId,
        }),
      );
      for (const operation of [
        'customer-profile-ico.read',
        'customer-profile-ico.write',
        'customer-profile-ico.migrate',
      ] as const) {
        governance.push(
          yield* seedOrganizationIcoNativeFixture({
            callers: [{ authMethod: 'session', principalId: human.principalId }],
            connections: isolated.connections,
            governancePrincipalId: human.principalId,
            legalEntityId,
            ownedDatabase: isolated,
            purpose,
            target: {
              expectedRevision: 1,
              kind: 'PROFILE',
              request: { fields: ORGANIZATION_PROFILE_ICO_FIELDS, operation, profileRef },
            },
            tenantId,
          }),
        );
      }
    }
    const partyUrl = new URL(Redacted.value(yield* Config.Redacted('PARTY_REGISTRY_DATABASE_URL')));
    const partyWorkerUrl = new URL(Redacted.value(yield* Config.Redacted('PARTY_REGISTRY_WORKER_DATABASE_URL')));
    for (const url of [partyUrl, partyWorkerUrl]) {
      url.pathname = `/${isolated.connections.runtime.database}`;
      url.hostname = isolated.connections.runtime.host;
      url.port = String(isolated.connections.runtime.port);
    }
    const environment = {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
      DATABASE_URL: isolated.connections.runtime.connectionString,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
      ONTOS_C14_TRACE_PROBLEMS: 'true',
      ONTOS_GATEWAY_ISSUER: shell.issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
      ONTOS_PRIVACY_ORGANIZATION_ICO_CONTEXTS: yield* json(governance.flatMap((value) => value.organizationContexts)),
      ONTOS_PRIVACY_ORGANIZATION_PROFILE_ICO_CONTEXTS: yield* json(
        governance.flatMap((value) => value.profileContexts),
      ),
      ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
      PARTY_REGISTRY_DATABASE_URL: partyUrl.href,
      PARTY_REGISTRY_WORKER_DATABASE_URL: partyWorkerUrl.href,
    };
    const prefixes = {
      'commerce-customer-context': '/commerce-customer-context-api',
      'party-registry': '/party-registry-api',
      privacy: '/privacy-api',
    } as const;
    const diagnostics = new Map<string, Effect.Effect<string>>();
    for (const appId of appIds) {
      const contract = contracts.find(({ deployment }) => deployment.appId === appId);
      const port = ports.get(appId);
      const moduleKey = moduleKeys.get(appId);
      if (contract === undefined || port === undefined || moduleKey === undefined) {
        return yield* unavailable('An actual company owner deployment is missing');
      }
      const owner = yield* startProductOwner({
        artifacts: yield* buildProductOwner(contract),
        contract,
        environment,
        moduleKey,
        port,
        prefix: prefixes[appId],
      });
      diagnostics.set(appId, owner.diagnostic);
    }
    const options = (appId: (typeof appIds)[number], idempotencyKey: string = randomUUID()) => ({
      baseUrl: new URL(prefixes[appId], `http://127.0.0.1:${ports.get(appId)}/`),
      compositionRevision: snapshot.composition.revision,
      idempotencyKey,
    });
    const authorize = Effect.fn('OrganizationProfileIcoHttp.authorize')(function* authorize(
      audience: (typeof appIds)[number],
    ) {
      const context = yield* shell.issueFixtureSetupGateway({ audience, legalEntityId });
      return `Bearer ${context.token}`;
    });
    const recordGovernance = Effect.fn('OrganizationProfileIcoHttp.recordGovernance')(function* recordGovernance() {
      const decisions: (typeof PrivacyApplicabilityDecisionSchema.Type)[] = [];
      for (const prepared of governance) {
        const decision = yield* executeRecordPrivacyApplicabilityWithAuthorization(
          prepared.recordPayload,
          yield* authorize('privacy'),
          `internal:company-ico:${prepared.decisionRef}`,
          options('privacy', randomUUID()),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PrivacyApplicabilityDecisionSchema)),
          Effect.tapError(() =>
            Effect.gen(function* recordFailureDiagnostics() {
              for (const [appId, diagnostic] of diagnostics) {
                const fs = yield* FileSystem.FileSystem;
                yield* fs.writeFileString(`/tmp/commerce-org-http-${appId}.diag.log`, yield* diagnostic);
                yield* Effect.logError({ appId, diagnosticFile: `/tmp/commerce-org-http-${appId}.diag.log` });
              }
              yield* Effect.logError({ gateway: yield* shell.gatewayDiagnostics() });
            }),
          ),
          Effect.mapError(() =>
            unavailable('Actual public RecordPrivacyApplicability failed with current owner facts'),
          ),
        );
        decisions.push(decision);
        const observed = yield* prepared.observe();
        if (Option.isNone(observed.decision)) {
          return yield* unavailable('The real applicability Action did not persist its decision');
        }
      }
      return decisions;
    });
    return {
      admin,
      authorize,
      diagnostics,
      governance,
      human,
      isolated,
      legalEntityId,
      options,
      parties,
      principal,
      profiles,
      recordGovernance,
      shell,
      snapshot,
      tenantId,
    };
  },
);
