import { enrollCustomerProfileSourceReaderNativeFixture } from '@app/commerce-customer-context/testing/customer-profile-source-reader';
import { randomUUID } from 'node:crypto';
import { issueDelegatedGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { CreatePriceGroupPayloadSchema } from '@app/price-group-catalog/actions/create-price-group';
import {
  CustomerGroupSourceAuthorityFixtureRouteSchema,
  seedCustomerGroupSourceAuthority,
} from '@app/commerce-customer-context/testing/customer-group-source-authority';
import { observeAcceptedEffectIdNativeFixture } from '@app/symmy-integration/testing/accepted-effect-native';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  CustomerProfileSourceAuthorityFixtureRouteSchema,
  seedCustomerProfileSourceAuthorityNativeFixture,
} from '@app/commerce-customer-context/testing/customer-profile-source-authority';
import {
  ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
  OrganizationProfileSourceCreateTemplateSchema,
  fingerprintOrganizationProfileSourceCreateTemplate,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import {
  OrganizationBusinessSourceFields,
  OrganizationBusinessSourceStatement,
  OrganizationBusinessSourceProjectionVersion,
  OrganizationBusinessOnboardFields,
  OrganizationBusinessOnboardTemplateProjectionVersion,
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  organizationBusinessSourceInputDigest,
  organizationBusinessOnboardTemplateDigest,
} from '@app/party-registry/apis/organization-record-facts';
import { OrganizationBusinessSourceIntentSchema } from '@app/privacy/api/organization-business-applicability';
import { executeRecordPrivacyApplicabilityWithAuthorization } from '@app/privacy/api/client';
import { seedOrganizationBusinessSourceNativeFixture } from '@app/privacy/testing/organization-business-source-native';
import { seedSourceProcessingNativeFixture } from '@app/privacy/testing/source-processing-native';
import { SourceProcessingContextSchema } from '@app/privacy/api/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy/api/source-processing-eligibility';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import {
  SymmyInternalExecutionPlanSchema,
  SymmyRouteExecutionConfigurationSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { SymmySourceOrganizationFactsGovernanceSelectorSchema } from '@app/symmy-integration/api/symmy-source-organization-facts';
import { PgClient } from '@effect/sql-pg';
import { Config, DateTime, Duration, Effect, Option, Redacted, Schedule, Schema } from 'effect';
import { HttpBody, HttpClient } from 'effect/http';
import {
  bindCustomerFixtureProviderKey,
  seedCustomerFixtureProviderPrincipal,
} from './symmy-c14-customer-native-authority.mts';
import { customerIntakeContext } from './symmy-c14-customer-rules.mts';
import {
  buildProductOwner,
  buildProductWorker,
  encodeProductComposition,
  nativePort,
  productComposition,
  startProductOwner,
  startProductWorker,
  SymmyC14ProductFixtureUnavailable,
} from './symmy-c14-product-runtime.mts';

const PARTY_CREATE_EFFECT = 'party-create';
const COUNTERPARTY_ONBOARD_EFFECT = 'counterparty-onboard';
const COUNTERPARTY_PROFILE_EFFECT = 'counterparty-profile';
const PARTY_MODULE_ID = 'party.registry';
const PRICE_RECORD_ID = 'ORGANIZATION_CUSTOMER_PRICE';
const COMMERCE_MODULE_ID = 'commerce.customer-context';
const PROVIDER_NAMESPACE = 'INTERNAL_ORGANIZATION_CUSTOMERS';
const PRICE_CREATE_KEY = 'pricing.price-group-catalog.create-price-group';
const MEMBERSHIP_WRITE_KEY = 'commerce.customer-context.apply-customer-group-membership-source';
const ASSIGN_ACTION = 'commerce.customer-context.assign-counterparty-price-group';
const SOURCE_READ_WORKLOAD = 'commerce.customer-context.source-read';
const PARTY_READ_WORKLOAD = 'party.registry.source-read';
const PROFILE_FACTS_WORKLOAD = 'commerce.customer-context.organization-ico-facts.read';
const PROFILE_ICO_WORKLOAD = 'privacy.core.organization-profile-ico-check';
const PRICE_READ_WORKLOAD = 'pricing.price-group-catalog.source-read';
const jobKey = 'integration.symmy.execute-symmy-job';
const commerceApp = 'commerce-customer-context';
const partyApp = 'party-registry';
const symmyApp = 'symmy-integration';
const priceGroupApp = 'price-group-catalog';
const purpose = 'implementation-1096-registered-workload-gateway';
const sourceWrite = 'commerce.customer-context.source-write';
const partyWrite = 'party.registry.source-write';
const businessRead = 'privacy.core.organization-business-check';
const ownerApps = [partyApp, commerceApp, 'privacy', priceGroupApp] as const;
const appIds = [...ownerApps, symmyApp] as const;
const json = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
export const organizationSourceFixture = {
  issuer: 'INTERNAL_ORGANIZATION_CUSTOMER_ISSUER',
  mappingRevision: 'explicit-organization-mapping-1',
  namespace: PROVIDER_NAMESPACE,
  recordType: 'CUSTOMER',
  routeRevision: 'explicit-organization-route-1',
} as const;
const receiptSchema = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('admitted'),
});
export const OrganizationSourceEffectObservationSchema = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  effectKey: SymmySourceOrganizationFactsGovernanceSelectorSchema.fields.effectKey,
  nativeStatus: Schema.OptionFromNullOr(Schema.String),
  outcomeStatus: Schema.OptionFromNullOr(Schema.String),
  ownerInvocationId: Schema.OptionFromNullOr(Schema.String),
  ownerReceipt: Schema.Unknown,
  state: Schema.String,
});

/** Configuration only: every Party, Counterparty and Profile is produced by the accepted native DAG. */
export const makeOrganizationSourceCustomerOwnerFixture = Effect.fn('OrganizationSourceCustomerOwner.fixture')(
  function* fixture() {
    const ports = new Map<string, number>();
    for (const app of appIds) {
      let port = yield* nativePort;
      while ([...ports.values()].includes(port)) {
        port = yield* nativePort;
      }
      ports.set(app, port);
    }
    const { contracts, snapshot } = yield* productComposition(
      Object.fromEntries([...ports].map(([app, port]) => [app, `http://127.0.0.1:${port}/`])),
    );
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: snapshot,
      mode: 'schema-only',
      purpose,
    });
    const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
    const shell = yield* makeApiKeyGatewayNativeFixture({
      additionalRelaySources: ownerApps.map((sourceAppId) => ({ sourceAppId })),
      ownedDatabase: isolated,
      productionGate: true,
      relaySource: { sourceAppId: symmyApp },
      snapshotJson: yield* encodeProductComposition(snapshot),
    });
    const tenantId = randomUUID();
    const legalEntityId = randomUUID();
    const systemId = randomUUID();
    const tenantSlug = `org-source-${tenantId}`;
    yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale) values(${tenantId},'Internal organization source customer',${tenantSlug},'active','en')`;
    yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId},${tenantId},'Internal organization source selling entity','CZ','INTERNAL_ONLY','active')`;
    const integration = yield* seedCustomerFixtureProviderPrincipal(
      admin,
      tenantId,
      'integration',
      shell.providerUserId,
    );
    yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${systemId},${tenantId},'system','active','Internal organization customer worker')`;
    for (const module of snapshot.composition.modules) {
      yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
    }
    yield* grantTestTenantRoleAccess({
      holders: [
        {
          capabilityKeys: [
            'privacy.core.privacy-applicability.record',
            'privacy.core.organization-business-applicability.read',
            'integration.symmy.symmy-source-organization-facts.read',
            'commerce.customer-context.customer-profile-organization-ico-facts.read',
            'party.registry.organization-record-facts.read',
            'party.registry.counterparty-organization-ico-facts.read',
            'privacy.core.organization-ico-applicability.read',
            'privacy.core.organization-profile-ico-applicability.read',
            'party.registry.legacy-ico-inventory.read',
            'party.registry.legacy-ico-authority.fence',
            'party.registry.organization-ico-facts.read',
            'party.registry.organization-business-name-export.read',
            'commerce.customer-context.organization-customer-profile-ico.read',
            'commerce.customer-context.organization-customer-profile-ico.change',
            'commerce.customer-context.organization-customer-profile-ico.migrate',
            'commerce.customer-context.organization-customer-profile-ico-migration.read',
          ],
          principalId: integration.issuerPrincipalId,
        },
      ],
      legalEntityIds: [legalEntityId],
      spiceDb: yield* loadSpiceDbConfig({ envPath: '/dev/null' }),
      tenantId,
      writerConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    });
    for (const principalId of [integration.principalId, systemId]) {
      for (const workload of [
        'integration.symmy-admit',
        'integration.symmy-poll',
        jobKey,
        partyWrite,
        PARTY_READ_WORKLOAD,
        sourceWrite,
        SOURCE_READ_WORKLOAD,
        businessRead,
        PROFILE_ICO_WORKLOAD,
        'integration.symmy.source-organization-facts.read',
        'pricing.price-group-catalog.source-write',
        PRICE_READ_WORKLOAD,
        PROFILE_FACTS_WORKLOAD,
      ]) {
        const bindingId = randomUUID();
        yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status) values(${bindingId},${randomUUID()},${tenantId},${principalId},${workload},'active')`;
        yield* admin`insert into core.access_workload_company_bindings(company_binding_id,incarnation,tenant_id,workload_binding_id,legal_entity_id,status)
          values(${randomUUID()},${randomUUID()},${tenantId},${bindingId},${legalEntityId},'active')`;
      }
    }
    const privacyBindingId = randomUUID();
    yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status) values(${privacyBindingId},${randomUUID()},${tenantId},${integration.principalId},'privacy.core.source-processing-check','active')`;
    yield* admin`insert into core.access_workload_company_bindings(company_binding_id,incarnation,tenant_id,workload_binding_id,legal_entity_id,status)
      values(${randomUUID()},${randomUUID()},${tenantId},${privacyBindingId},${legalEntityId},'active')`;
    const key = yield* shell.issueFixtureProviderKey(integration);
    yield* bindCustomerFixtureProviderKey(admin, integration, key.providerKeyId);
    yield* key.acknowledgeBinding;
    // Each owner's own module key, provisioned by the platform for its module principal as on every environment.
    const symmyKey = yield* shell.provisionRelaySource();
    const moduleKeys = new Map<string, Redacted.Redacted>([[symmyApp, symmyKey.secret]]);
    for (const app of ownerApps) {
      moduleKeys.set(app, (yield* shell.provisionModuleSource(app)).secret);
    }
    const sourceRouteId = randomUUID();
    const routeId = randomUUID();
    const occurrenceId = randomUUID();
    const recordId = 'INTERNAL_ORGANIZATION_CUSTOMER_17';
    const instant = DateTime.formatIso(yield* DateTime.now);
    const sourceReference = {
      occurrenceId,
      recordId,
      source: {
        issuer: organizationSourceFixture.issuer,
        namespace: organizationSourceFixture.namespace,
        recordType: organizationSourceFixture.recordType,
        routeRef: sourceRouteId,
      },
    };
    const candidate = {
      businessName: 'Internal organization customer seventeen',
      evidenceRefs: [],
      officialIdentifiers: [],
      partyType: 'ORGANIZATION',
      provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: sourceRouteId },
      subjectEvidence: [
        {
          ...sourceReference,
          kind: 'CLIENT_SOURCE_ASSERTION',
          observedSubject: 'ORGANIZATION',
          sourceObservedAt: instant,
          statement: OrganizationBusinessSourceStatement,
          subjectKey: recordId,
        },
      ],
      validFrom: instant,
    };
    const onboard = {
      _tag: 'OnboardCounterpartyCustomerFromParty',
      fromPartyEffect: { effectKey: PARTY_CREATE_EFFECT, itemKey: 'organization' },
      payload: {
        counterpartyProvenance: {
          evidenceReference: recordId,
          method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
          reason: OrganizationBusinessCounterpartyContextReason,
          source: sourceRouteId,
        },
        customerEvidence: {
          evidenceReference: recordId,
          method: 'APPROVED_PURCHASING_RELATIONSHIP',
          reason: OrganizationBusinessCustomerRoleReason,
          source: sourceRouteId,
        },
        sourceReference,
        validFrom: instant,
      },
    };
    const profile = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceCreateTemplateSchema)({
      _tag: 'CreateCounterpartyProfileFromCounterparty',
      fromCounterpartyEffect: { effectKey: COUNTERPARTY_ONBOARD_EFFECT, itemKey: 'organization' },
      payload: {
        effectiveAt: instant,
        partySourceReference: sourceReference,
        source: {
          ...organizationSourceFixture,
          effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
          occurrenceId,
          order: 1,
          recordId,
          revision: '1',
          route: { id: sourceRouteId, revision: organizationSourceFixture.routeRevision },
        },
        subject: {
          kind: 'COUNTERPARTY',
          sellingLegalEntityRef: {
            moduleId: 'core.identity',
            resourceId: legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId,
          },
        },
        trigger: 'AUTHORIZED_ONBOARDING',
      },
    });
    const encodedProfile = yield* Schema.encodeEffect(OrganizationProfileSourceCreateTemplateSchema)(profile);
    const groupSource = {
      definitionEvidence: {
        kind: 'NAMED_CONFIGURATION',
        reference: 'internal:whole1096:organization-customer-segment',
        revision: '1',
      },
      effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
      issuer: organizationSourceFixture.issuer,
      mappingRevision: organizationSourceFixture.mappingRevision,
      namespace: PROVIDER_NAMESPACE,
      order: 1,
      recordId: 'ORGANIZATION_CUSTOMER_SEGMENT',
      revision: '1',
      route: { id: sourceRouteId, revision: organizationSourceFixture.routeRevision },
      sourceCode: 'INTERNAL_ORGANIZATION_CUSTOMER_SEGMENT',
    };
    const groupPayload = yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)({
      businessCode: 'INTERNAL_ORGANIZATION_CUSTOMER_SEGMENT',
      description: 'Explicit isolated Organization CUSTOMER segment for whole1096 conformance',
      initialState: 'ACTIVE',
      meaningKey: 'internal.organization-customer-segment',
      membershipCriteria:
        'Canonical ORGANIZATION with explicit current CUSTOMER admission in the selected selling legal entity',
      name: 'Internal organization customer segment',
      purpose: 'Internal whole1096 source Organization CUSTOMER membership conformance',
      reason: 'Internal explicit named configuration version 1',
      source: groupSource,
    });
    yield* seedCustomerGroupSourceAuthority({
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      fixture: isolated,
      operatorPrincipalId: integration.issuerPrincipalId,
      operatorProviderUserId: shell.providerUserId,
      route: yield* Schema.decodeUnknownEffect(CustomerGroupSourceAuthorityFixtureRouteSchema)({
        active: true,
        issuer: groupSource.issuer,
        legalEntityId,
        mappingRevision: groupSource.mappingRevision,
        namespace: groupSource.namespace,
        principalId: systemId,
        routeId: groupSource.route.id,
        routeRevision: groupSource.route.revision,
        tenantId,
      }),
    });
    const priceEffectiveFrom = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(instant), { seconds: 60 }));
    const pricePayload = yield* Schema.decodeUnknownEffect(CreatePriceGroupPayloadSchema)({
      businessCode: 'INTERNAL_ORGANIZATION_CUSTOMER_PRICE',
      classificationPurpose: 'Internal whole1096 organization CUSTOMER price assignment conformance',
      compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment.v1', version: 1 }],
      description: 'Native isolated price classification producer for actual Organization customer assignment',
      displayName: 'Internal organization customer price',
      effectiveFrom: priceEffectiveFrom,
      effectiveTo: null,
      expectedCatalogRevision: 0,
      reason: 'Internal explicit organization customer price definition',
      sourceCorrelation: {
        issuer: organizationSourceFixture.issuer,
        mappingVersion: organizationSourceFixture.mappingRevision,
        namespace: PROVIDER_NAMESPACE,
        recordKey: PRICE_RECORD_ID,
        routeId: sourceRouteId,
      },
    });
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: PARTY_CREATE_EFFECT,
              intent: { _tag: 'PartyCreate', payload: { candidate } },
              operation: {
                entrypointKey: 'party.registry.create-party',
                moduleId: PARTY_MODULE_ID,
                schemaVersion: '1',
              },
            },
            {
              dependsOn: [PARTY_CREATE_EFFECT],
              effectKey: COUNTERPARTY_ONBOARD_EFFECT,
              intent: onboard,
              operation: {
                entrypointKey: 'party.registry.counterparty-customer-onboard',
                moduleId: PARTY_MODULE_ID,
                schemaVersion: '1',
              },
            },
            {
              dependsOn: [COUNTERPARTY_ONBOARD_EFFECT],
              effectKey: COUNTERPARTY_PROFILE_EFFECT,
              intent: encodedProfile,
              operation: {
                entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
                moduleId: COMMERCE_MODULE_ID,
                schemaVersion: '1',
              },
            },
          ],
          itemKey: 'organization',
          source: {
            entityKind: organizationSourceFixture.recordType,
            issuerId: organizationSourceFixture.issuer,
            sourceNamespace: organizationSourceFixture.namespace,
            sourceRecordId: recordId,
          },
          sourceOccurrenceId: occurrenceId,
        },
        {
          effects: [
            {
              effectKey: 'organization-group-create',
              intent: {
                _tag: 'CustomerGroupCreate',
                payload: yield* Schema.encodeEffect(CreateCustomerGroupPayloadSchema)(groupPayload),
              },
              operation: {
                entrypointKey: 'commerce.customer-context.create-customer-group',
                moduleId: COMMERCE_MODULE_ID,
                schemaVersion: '1',
              },
            },
          ],
          itemKey: 'organization-group-definition',
          source: {
            entityKind: 'CUSTOMER_GROUP',
            issuerId: groupSource.issuer,
            sourceNamespace: groupSource.namespace,
            sourceRecordId: groupSource.recordId,
          },
          sourceOccurrenceId: randomUUID(),
        },
        {
          effects: [
            {
              effectKey: 'organization-price-create',
              intent: {
                _tag: 'PriceGroupCreate',
                payload: yield* Schema.encodeEffect(CreatePriceGroupPayloadSchema)(pricePayload),
              },
              operation: {
                entrypointKey: PRICE_CREATE_KEY,
                moduleId: 'pricing.price-group-catalog',
                schemaVersion: '1',
              },
            },
          ],
          itemKey: 'organization-price-definition',
          source: {
            entityKind: 'PRICE_GROUP',
            issuerId: organizationSourceFixture.issuer,
            sourceNamespace: PROVIDER_NAMESPACE,
            sourceRecordId: PRICE_RECORD_ID,
          },
          sourceOccurrenceId: randomUUID(),
        },
      ],
    });
    const route = yield* Schema.decodeUnknownEffect(CustomerProfileSourceAuthorityFixtureRouteSchema)({
      active: true,
      issuer: organizationSourceFixture.issuer,
      legalEntityId,
      mappingRevision: organizationSourceFixture.mappingRevision,
      namespace: organizationSourceFixture.namespace,
      principalId: systemId,
      recordType: organizationSourceFixture.recordType,
      route: { id: sourceRouteId, revision: organizationSourceFixture.routeRevision },
      tenantId,
    });
    yield* seedCustomerProfileSourceAuthorityNativeFixture({
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      legalEntityId,
      operatorPrincipalId: integration.issuerPrincipalId,
      operatorProviderUserId: shell.providerUserId,
      ownedDatabase: isolated,
      route,
      tenantId,
    });
    const encodedPlan = yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(plan);
    const configuration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
      ...encodedPlan,
      items: encodedPlan.items.map((item) => ({
        ...item,
        effects: [
          ...item.effects,
          {
            effectKey: 'allowed-org-membership',
            operation: {
              entrypointKey: MEMBERSHIP_WRITE_KEY,
              moduleId: COMMERCE_MODULE_ID,
              schemaVersion: '1',
            },
          },
          {
            effectKey: 'allowed-org-price-assign',
            operation: {
              entrypointKey: ASSIGN_ACTION,
              moduleId: COMMERCE_MODULE_ID,
              schemaVersion: '1',
            },
          },
          {
            effectKey: 'allowed-org-ico-change',
            operation: {
              entrypointKey: 'commerce.customer-context.change-organization-customer-profile-ico',
              moduleId: COMMERCE_MODULE_ID,
              schemaVersion: '1',
            },
          },
          {
            effectKey: 'allowed-org-name-update',
            operation: { entrypointKey: 'party.registry.update-party', moduleId: PARTY_MODULE_ID, schemaVersion: '1' },
          },
        ],
      })),
      sourceRouteId,
    });
    const lifecyclePolicy = { policyId: 'INTERNAL_ORGANIZATION_SOURCE_RETENTION', revision: '1' };
    yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy) values(${routeId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(configuration)}::jsonb,${organizationSourceFixture.mappingRevision},'customersBatch',${organizationSourceFixture.routeRevision},${yield* json(lifecyclePolicy)}::jsonb)`;
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
      ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: yield* json([
        { ...sourceReference.source, authMethod: 'api_key', principalId: integration.principalId, tenantId },
        { ...sourceReference.source, authMethod: 'system', principalId: systemId, tenantId },
      ]),
      ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
      ONTOS_SYMMY_JOB_RETENTION_POLICIES: yield* json([
        {
          ...lifecyclePolicy,
          governanceLegalEntityId: legalEntityId,
          retentionMs: Duration.toMillis(Duration.minutes(5)),
          routeId,
          targetLegalEntityId: legalEntityId,
          tenantId,
        },
      ]),
      PARTY_REGISTRY_DATABASE_URL: partyUrl.href,
      PARTY_REGISTRY_WORKER_DATABASE_URL: partyWorkerUrl.href,
    };
    const prefixes = {
      [commerceApp]: '/commerce-customer-context-api',
      [partyApp]: '/party-registry-api',
      [priceGroupApp]: '/price-group-catalog-api',
      privacy: '/privacy-api',
      [symmyApp]: '/symmy-integration-api',
    } as const;
    const runtimes = new Map<string, Effect.Success<ReturnType<typeof startProductOwner>>>();
    const artifacts = new Map<string, Effect.Success<ReturnType<typeof buildProductOwner>>>();
    const intakeContexts: (typeof SourceProcessingContextSchema.Type)[] = [];
    const seedIntake = Effect.fn('OrganizationSourceCustomerOwner.seedIntake')(function* seedIntake(
      sourceOccurrenceId: string,
      target: NonNullable<SourceProcessingEligibilityRequest['target']>,
      uses: readonly NonNullable<SourceProcessingEligibilityRequest['organizationBusinessUse']>[],
    ) {
      const seeded = yield* seedSourceProcessingNativeFixture({
        connections: isolated.connections,
        contexts: uses.map((organizationBusinessUse) => {
          const base = customerIntakeContext(
            integration.principalId,
            { ...sourceReference.source, occurrenceId: sourceOccurrenceId, recordId: sourceReference.recordId },
            target,
          );
          return { ...base, request: { ...base.request, organizationBusinessUse } };
        }),
        contractEvidenceRef: 'INTERNAL_C14_EXACT_ORGANIZATION_INTAKE',
        controllerRef: 'internal:organization-customer-conformance',
        dataCategoryRefs: ['INTERNAL_C14_ORGANIZATION_CUSTOMER_BUSINESS_RECORD'],
        governancePrincipalId: integration.issuerPrincipalId,
        legalEntityId,
        meaning: 'Explicit internal staging for this current canonical company and qualified source record',
        tenantId,
      });
      intakeContexts.push(...seeded.contexts);
    });
    const start = Effect.fn('OrganizationSourceCustomerOwner.start')(function* start(
      app: (typeof appIds)[number],
      extra: Readonly<Record<string, string>> = {},
    ) {
      const contract = contracts.find((value) => value.deployment.appId === app);
      const port = ports.get(app);
      const moduleKey = moduleKeys.get(app);
      if (contract === undefined || port === undefined || moduleKey === undefined) {
        return yield* unavailable('An actual owner endpoint or independent credential is missing');
      }
      let artifact = artifacts.get(app);
      if (artifact === undefined) {
        artifact = yield* buildProductOwner(contract);
        artifacts.set(app, artifact);
      }
      const previous = runtimes.get(app);
      if (previous !== undefined) {
        yield* previous.child.kill();
        yield* previous.child.exitCode;
      }
      const ownerEnvironment = { ...environment, ...extra };
      if (app === 'privacy') {
        const encodedIntakeContexts = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
        )(intakeContexts);
        Object.assign(ownerEnvironment, { ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: encodedIntakeContexts });
      }
      const runtime = yield* startProductOwner({
        artifacts: artifact,
        contract,
        environment: ownerEnvironment,
        moduleKey,
        port,
        prefix: prefixes[app],
      });
      runtimes.set(app, runtime);
      return runtime;
    });
    for (const app of appIds) {
      yield* start(app);
    }
    let workerDiagnostic = Effect.succeed('Worker has not started');
    const writeDiagnostics = Effect.fn('OrganizationSourceCustomerOwner.diagnostics')(function* writeDiagnostics() {
      for (const [app, runtime] of runtimes) {
        yield* Effect.logError({ app, ownerTrace: (yield* runtime.diagnostic).slice(-6000) });
      }
      yield* Effect.logError({
        gateway: yield* shell.gatewayDiagnostics(),
        issuer: yield* shell.issuerDiagnostics(),
        requests: yield* shell.requestDiagnostics(),
        workerTrace: (yield* workerDiagnostic).slice(-6000),
      });
    });
    const client = yield* HttpClient.HttpClient;
    const submitFor = (idempotencyKey: string, submittedPlan: typeof SymmyInternalExecutionPlanSchema.Type) =>
      Effect.gen(function* submit() {
        const response = yield* client.post(`${shell.baseUrl}/api/symmy/v1/customers/batch`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(submittedPlan),
          }),
          headers: { 'idempotency-key': idempotencyKey, 'x-api-key': Redacted.value(key.secret) },
        });
        if (response.status !== 202) {
          yield* writeDiagnostics();
          yield* Effect.logError({
            issuer: yield* shell.issuerDiagnostics(),
            requests: yield* shell.requestDiagnostics(),
          });
          return yield* unavailable(`Actual Organization job admission ${response.status}: ${yield* response.text}`);
        }
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
      });
    const submit = submitFor('INTERNAL_ORGANIZATION_SOURCE_JOB', plan);
    const accepted = yield* submit;
    const partyDigest = yield* organizationBusinessSourceInputDigest({ operation: 'CREATE', payload: { candidate } });
    const onboardDigest = yield* organizationBusinessOnboardTemplateDigest(onboard);
    const assignedProfileEffectId = yield* observeAcceptedEffectIdNativeFixture({
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      effectKey: COUNTERPARTY_PROFILE_EFFECT,
      jobId: accepted.jobId,
      legalEntityId,
      operatorPrincipalId: integration.issuerPrincipalId,
      operatorProviderUserId: shell.providerUserId,
      ownedDatabase: isolated,
      purpose,
      tenantId,
    });
    const acceptedProfile = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceCreateTemplateSchema, {
      onExcessProperty: 'error',
    })({
      ...encodedProfile,
      payload: {
        ...encodedProfile.payload,
        source: { ...encodedProfile.payload.source, effectId: assignedProfileEffectId },
      },
    });
    const profileDigest = yield* fingerprintOrganizationProfileSourceCreateTemplate(acceptedProfile);
    const inputs = [
      {
        effectKey: PARTY_CREATE_EFFECT,
        intent: {
          consumerModuleId: PARTY_MODULE_ID,
          fields: OrganizationBusinessSourceFields,
          inputDigest: partyDigest.inputDigest,
          kind: 'SOURCE_ASSERTED',
          operation: 'CREATE',
          projectionVersion: OrganizationBusinessSourceProjectionVersion,
          sourceReference,
        },
      },
      {
        effectKey: COUNTERPARTY_ONBOARD_EFFECT,
        intent: {
          consumerModuleId: PARTY_MODULE_ID,
          fields: OrganizationBusinessOnboardFields,
          inputDigest: onboardDigest.semanticInputDigest,
          kind: 'SOURCE_ASSERTED',
          operation: 'ONBOARD_COUNTERPARTY_CUSTOMER',
          projectionVersion: OrganizationBusinessOnboardTemplateProjectionVersion,
          sourceReference,
        },
      },
      {
        effectKey: COUNTERPARTY_PROFILE_EFFECT,
        intent: {
          consumerModuleId: COMMERCE_MODULE_ID,
          fields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
          inputDigest: profileDigest,
          kind: 'SOURCE_ASSERTED',
          operation: 'COUNTERPARTY_PROFILE_CREATE',
          profileSource: acceptedProfile.payload.source,
          projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
          sourceReference,
        },
      },
    ];
    const prepared = [];
    for (const input of inputs) {
      const governanceSelector = yield* Schema.decodeUnknownEffect(
        SymmySourceOrganizationFactsGovernanceSelectorSchema,
      )({
        effectKey: input.effectKey,
        execution: { jobId: accepted.jobId, kind: 'JOB' },
        purpose: 'GOVERNANCE',
        sourceReference,
      });
      const intent = yield* Schema.decodeUnknownEffect(OrganizationBusinessSourceIntentSchema)(input.intent);
      prepared.push(
        yield* seedOrganizationBusinessSourceNativeFixture({
          callers: [
            { authMethod: 'session', principalId: integration.issuerPrincipalId },
            { authMethod: 'system', principalId: systemId },
          ],
          connections: isolated.connections,
          governancePrincipalId: integration.issuerPrincipalId,
          governanceSelector,
          intent,
          legalEntityId,
          ownedDatabase: isolated,
          purpose,
          tenantId,
        }),
      );
    }
    yield* start('privacy', {
      ONTOS_PRIVACY_ORGANIZATION_BUSINESS_CONTEXTS: yield* json(prepared.flatMap((value) => value.contexts)),
    });
    for (const decision of prepared) {
      if (Option.isSome((yield* decision.observe()).decision)) {
        return yield* unavailable('Source policy setup unexpectedly created a governance decision');
      }
      const gateway = yield* shell.issueFixtureSetupGateway({ audience: 'privacy', legalEntityId });
      yield* executeRecordPrivacyApplicabilityWithAuthorization(
        decision.recordPayload,
        `Bearer ${gateway.token}`,
        randomUUID(),
        {
          baseUrl: new URL(prefixes.privacy, `http://127.0.0.1:${ports.get('privacy')}/`),
          compositionRevision: snapshot.composition.revision,
          idempotencyKey: randomUUID(),
        },
      ).pipe(Effect.tapCause(() => writeDiagnostics()));
      if (Option.isNone((yield* decision.observe()).decision)) {
        return yield* unavailable('Actual source governance did not persist through the public Action');
      }
    }
    const symmyContract = contracts.find((value) => value.deployment.appId === symmyApp);
    if (symmyContract === undefined) {
      return yield* unavailable('The actual Symmy worker contract is missing');
    }
    const workerArtifact = yield* buildProductWorker(symmyContract);
    const startWorker = Effect.fn('OrganizationSourceCustomerOwner.startWorker')(function* startWorker() {
      const started = yield* startProductWorker(
        workerArtifact,
        { ...environment, ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_ORGANIZATION_SOURCE_WORKER' },
        symmyKey.secret,
      );
      workerDiagnostic = started.diagnostic;
      return started;
    });
    const worker = yield* startWorker();
    const ledgerFor = (jobId: typeof receiptSchema.Type.jobId) =>
      admin`select e.effect_id::text as "effectId",e.effect_key as "effectKey",a.status as "nativeStatus",e.outcome->>'status' as "outcomeStatus",e.owner_invocation_id::text as "ownerInvocationId",e.owner_receipt as "ownerReceipt",e.state from symmy_integration.job_effects e left join core.action_invocations a on a.action_invocation_id=e.owner_invocation_id and a.tenant_id=e.tenant_id where e.job_id=${jobId} and e.tenant_id=${tenantId} order by e.effect_key`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OrganizationSourceEffectObservationSchema))),
      );
    const awaitSettled = Effect.fn('OrganizationSourceCustomerOwner.awaitSettled')(function* awaitSettled(
      jobId: typeof receiptSchema.Type.jobId,
      expectedEffects: number,
    ) {
      const observe = ledgerFor(jobId);
      const settled = (rows: Effect.Success<typeof observe>) =>
        rows.length === expectedEffects && rows.every(({ state }) => state === 'settled');
      const terminal = (rows: Effect.Success<typeof observe>) =>
        rows.length === expectedEffects && rows.every(({ state }) => state === 'settled' || state === 'blocked');
      const rows = yield* observe.pipe(
        Effect.repeat({ schedule: Schedule.spaced('200 millis'), until: terminal }),
        Effect.timeoutOrElse({ duration: '120 seconds', orElse: () => observe }),
      );
      const acceptedStatus = Schema.is(Schema.Literals(['accepted_change', 'accepted_no_change']));
      if (!settled(rows) || rows.some(({ outcomeStatus }) => !Option.exists(outcomeStatus, acceptedStatus))) {
        yield* Effect.logError({
          phase: 'organization-effect-observation',
          rows: rows.map(({ effectKey, nativeStatus, outcomeStatus, ownerReceipt, state }) => ({
            effectKey,
            nativeStatus: Option.getOrNull(nativeStatus),
            outcomeStatus: Option.getOrNull(outcomeStatus),
            receiptPresent: ownerReceipt !== null,
            state,
          })),
        });
        yield* writeDiagnostics();
      }
      return rows;
    });
    const options = (app: (typeof appIds)[number], idempotencyKey: string = randomUUID()) => ({
      baseUrl: new URL(prefixes[app], `http://127.0.0.1:${ports.get(app)}/`),
      compositionRevision: snapshot.composition.revision,
      idempotencyKey,
    });
    const authorize = (audience: 'privacy' | 'commerce-customer-context' | 'party-registry') =>
      shell
        .issueFixtureSetupGateway({ audience, legalEntityId })
        .pipe(Effect.map((gateway) => `Bearer ${gateway.token}`));
    const statusFor = Effect.fn('OrganizationSourceCustomerOwner.status')(function* statusFor(
      jobId: typeof receiptSchema.Type.jobId,
    ) {
      const response = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${jobId}`, {
        headers: { 'x-api-key': Redacted.value(key.secret) },
      });
      if (response.status !== 200) {
        return yield* unavailable('Actual job status is unavailable');
      }
      return yield* response.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Struct({ jobId: receiptSchema.fields.jobId, status: Schema.String })),
        ),
      );
    });
    let companyReadConfigured = false;
    const getCompany = Effect.fn('OrganizationSourceCustomerOwner.getCompany')(function* getCompany() {
      const { source } = acceptedProfile.payload;
      if (!companyReadConfigured) {
        yield* enrollCustomerProfileSourceReaderNativeFixture({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          authority: {
            issuer: source.issuer,
            mappingRevision: source.mappingRevision,
            namespace: source.namespace,
            recordType: source.recordType,
            route: source.route,
          },
          legalEntityId,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          ownedDatabase: isolated,
          readerPrincipalId: integration.principalId,
          tenantId,
        });
        const readRoute = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
          items: [
            {
              effects: [
                {
                  effectKey: 'organization-profile-read',
                  operation: {
                    entrypointKey: 'commerce.customer-context.api.customer-profile-source',
                    moduleId: COMMERCE_MODULE_ID,
                    schemaVersion: '1',
                  },
                },
                {
                  effectKey: 'organization-ico-read',
                  operation: {
                    entrypointKey: 'commerce.customer-context.api.organization-customer-profile-ico',
                    moduleId: COMMERCE_MODULE_ID,
                    schemaVersion: '1',
                  },
                },
                {
                  effectKey: 'organization-name-read',
                  operation: {
                    entrypointKey: 'party.registry.api.organization-business-name-export',
                    moduleId: PARTY_MODULE_ID,
                    schemaVersion: '1',
                  },
                },
              ],
              itemKey: 'organization-source-read',
              source: {
                entityKind: source.recordType,
                issuerId: source.issuer,
                sourceNamespace: source.namespace,
                sourceRecordId: source.recordId,
              },
            },
          ],
          sourceRouteId: source.route.id,
        });
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision) values(${randomUUID()},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(readRoute)}::jsonb,${source.mappingRevision},'adminCustomers',${source.route.revision})`;
        companyReadConfigured = true;
      }
      return yield* client.get(
        `${shell.baseUrl}/api/symmy/v1/admin/customers?contractVersion=INTERNAL_C14&code=${encodeURIComponent(source.recordId)}`,
        { headers: { 'x-api-key': Redacted.value(key.secret) } },
      );
    });
    const readOriginalReceipt = Effect.fn('OrganizationSourceCustomerOwner.originalReceipt')(
      function* originalReceipt(input: {
        readonly actionInvocationId: string;
        readonly actionKey: string;
        readonly body: Schema.Json;
        readonly declarationKey: string;
        readonly endpoint: string;
        readonly readKey: string;
        readonly requestHash: string;
      }) {
        const nativeRows =
          yield* admin`select a.action_invocation_id as "actionInvocationId",a.action_key as "actionKey",a.auth_context_ref as "authContextRef",a.idempotency_key as "idempotencyKey",a.principal_id as "principalId",a.request_hash as "requestHash" from core.action_invocations a join symmy_integration.job_effects e on e.tenant_id=a.tenant_id and e.owner_invocation_id=a.action_invocation_id and e.owner_executor_principal_id=a.principal_id and e.owner_request_hash=a.request_hash and e.owner_auth_context_ref=a.auth_context_ref and a.idempotency_key=e.effect_id::text where a.action_invocation_id=${input.actionInvocationId} and a.tenant_id=${tenantId} and a.legal_entity_id=${legalEntityId} and a.status='succeeded'`;
        const [native] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              actionInvocationId: Schema.String.check(Schema.isUUID()).pipe(
                Schema.brand('OrganizationOriginalInvocationId'),
              ),
              actionKey: Schema.Literals([MEMBERSHIP_WRITE_KEY, ASSIGN_ACTION]),
              authContextRef: Schema.String,
              idempotencyKey: Schema.String.pipe(Schema.brand('OrganizationOriginalIdempotencyKey')),
              principalId: TrustedPrincipalContextSchema.fields.principalId,
              requestHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
            }),
          ]),
        )(nativeRows);
        const prefix = `job:${jobKey}:run:`;
        if (
          native.actionKey !== input.actionKey ||
          native.principalId !== systemId ||
          !native.authContextRef.startsWith(prefix)
        ) {
          return yield* unavailable('Original native receipt must have the exact retained Core delivery identity');
        }
        const deliveryId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(
          native.authContextRef.slice(prefix.length),
        );
        let done = false;
        for (let attempt = 0; attempt < 300 && !done; attempt += 1) {
          const [delivery] = yield* admin<{
            status: string;
          }>`select status from core.outbox_deliveries where outbox_delivery_id=${deliveryId}`;
          done = delivery?.status === 'done';
          if (!done) {
            yield* Effect.sleep(Duration.millis(50));
          }
        }
        if (!done) {
          return yield* unavailable('The genuine original worker delivery must finish before historical recovery');
        }
        const [requirement] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ key: Schema.String })]))(
          (symmyContract.manifest.requirements?.operations ?? []).filter(
            (operation) => operation.entrypointKey === jobKey && operation.provider.entrypointKey === input.readKey,
          ),
        );
        const issued = yield* issueDelegatedGatewayContext(
          {
            audience: commerceApp,
            compositionRevision: snapshot.composition.revision,
            exchangeId: randomUUID(),
            legalEntityScope: 'subject',
            subject: {
              _tag: 'RegisteredRecovery',
              declarationKey: input.declarationKey,
              expectedPrincipalId: systemId,
              operationRequirementKey: requirement.key,
              originalActionKey: native.actionKey,
              originalIdempotencyKey: native.idempotencyKey,
              originalPrincipalId: native.principalId,
              originalRequestHash: native.requestHash,
              requestHash: input.requestHash,
              source: { _tag: 'HistoricalDelivery', deliveryId, legalEntityId, tenantId, workerKey: jobKey },
            },
          },
          { apiKey: symmyKey.secret, baseUrl: shell.baseUrl, requestCorrelation: randomUUID() },
        );
        if (
          issued.recovery?.originalActionInvocationId !== native.actionInvocationId ||
          issued.machineContext?.principalId !== systemId
        ) {
          return yield* unavailable(
            'Shell must independently seal the exact original native invocation and current reader',
          );
        }
        return yield* client.post(`${new URL(issued.apiBaseUrl, shell.baseUrl)}/reads/${input.endpoint}`, {
          body: yield* HttpBody.json(input.body),
          headers: {
            authorization: `Bearer ${issued.token}`,
            'x-correlation-id': randomUUID(),
            'x-ontos-composition-revision': issued.compositionRevision,
          },
        });
      },
    );
    return {
      accepted,
      acceptedProfile,
      admin,
      authorize,
      awaitSettled,
      getCompany,
      groupSource,
      integration,
      isolated,
      key,
      ledgerFor,
      legalEntityId,
      options,
      plan,
      ports,
      prepared,
      priceEffectiveFrom,
      profile,
      readOriginalReceipt,
      seedIntake,
      shell,
      snapshot,
      sourceReference,
      sourceRouteId,
      start,
      startWorker,
      statusFor,
      submit,
      submitFor,
      systemId,
      tenantId,
      worker,
      writeDiagnostics,
    };
  },
);
