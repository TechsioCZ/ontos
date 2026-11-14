import {
  ActiveApplicationCompositionService,
  AccessActorSchema,
  AccessDeclarationSchema,
  ActionRuntime,
  ActionTrustedContextValidationError,
  ContextAccessLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OwnerAuthorizationOverlayAllowLive,
  ReadRuntime,
  defineAction,
  defineRead,
  defineOutboxWorker,
  defineOntosModuleManifest,
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  makeActionRuntimeLive,
  makeReadRuntimeLive,
  AccessWorkloadSchema,
  parseDatabaseConfig,
  GatewayScopeGrantRegistrar,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  PrincipalResolver,
  OperationalScopeResolver,
  TenantModuleStateService,
  defineTenantModuleEntrypoint,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  makePrincipalResolver,
  makeSystemPrincipalContextResolver,
  makeTenantModuleStateService,
  registerSystemWorkload,
  OntosModuleRequirementsSchema,
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  makeDatabaseIdentityEnrollmentLive,
  OntosRegisteredWorkloadCallSchema,
  OntosRegisteredWorkloadCallsSchema,
} from '@app/core-runtime';
import {
  AccessDecisionGate,
  AccessWorkloadBindingIdSchema,
  AccessWorkloadCompanyBindingIdSchema,
  computeActionRequestHash,
  computeCanonicalValueHash,
  makeAccessDecisionService,
  makeAccessWorkloadCompanyBindingDrizzleStore,
  makeDrizzleAccessPrincipalKinds,
  makeDrizzleAccessWorkloadBindings,
} from '@app/core-runtime/access/enforcement';
import { bootstrapScopesOf, writeBootstrapScopes } from '@app/core-runtime/access/bootstrap';
import { LegalEntityIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import type { GatewayAssertionRedemptionInput } from '@app/core-runtime';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import {
  readVerifiedGatewayRecovery,
  readVerifiedGatewayOrganizationProcessingRead,
  readVerifiedGatewayWorkload,
  readVerifiedGatewayRouteScope,
  RegisteredGatewayRouteScopeSchema,
  RegisteredGatewayWorkloadSchema,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/gateway-scope-grant';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { makeTestOperationalScopeAccess } from '@app/core-runtime/testing/access-gate';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '@app/core-runtime/auth/external-identity-admission';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import {
  GatewayDelegatedContextRequestSchema,
  GatewayTrustedPrincipalContextSchema,
  GatewayRegisteredAssertionSubjectSchema,
  GatewayActorClaimSchema,
} from '@app/shared-contracts';
import {
  SymmySourceOrganizationFactsApi,
  SymmySourceOrganizationFactsProcessingSelectorSchema,
  SymmySourceOrganizationFactsRequestSchema,
  SymmySourceOrganizationFactsResponseSchema,
} from '@app/symmy-integration/api/symmy-source-organization-facts';
import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
  ActionPermissionLive,
  ActionRepositoryLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  outboxProducerModuleKey,
  outboxTopic,
  OutboxPayloadSchema as SymmyJobPayloadSchema,
} from '@app/symmy-integration/outbox/integration-symmy-job-admitted-v1';
import { importJobResourceDescriptor } from '@app/symmy-integration/resources/import-job';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import {
  Cause,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { Base64Url } from 'effect/encoding';
import { loadGatewayModuleBindings } from '../../api/auth/gateway-delegation-policy.ts';
import { admitAssertionSubject, readVerifiedGatewayAssertion } from '../../api/auth/gateway-assertion-evidence.ts';
import {
  admitRegisteredAssertionWorkload,
  takeAdmittedOrganizationProcessingRead,
} from '../../api/auth/gateway-registered-assertion.ts';

import { makeAuthDatabase, AuthDatabase } from '../../api/auth/db/client.ts';
import {
  GatewayIssuer,
  issueRouteScopedGatewayContextAssertion,
  issueOrganizationProcessingReadGatewayContextAssertion,
  makeGatewayIssuerLayer,
} from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import { issueDelegatedGatewayContextAssertion } from '../../api/auth/gateway-delegation-issuer.ts';
import { makeGatewayDelegationVerificationLayer } from '../../api/auth/gateway-delegation-verification.ts';
import { GatewayOriginatorEvidenceLive } from '../../api/auth/gateway-originator-evidence.service.ts';
import {
  GatewayDelegationExchangeLedger,
  makeGatewayDelegationExchangeLedger,
} from '../../api/auth/gateway-delegation-exchanges.service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { enrolledModuleCredentials } from '../support/module-credential-enrolment.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';

const sourceApp = 'symmy-integration';
const sourceModule = outboxProducerModuleKey;
const sourceAction = 'integration.symmy.admit-fixture';
const sourceWorkload = 'integration.fixture.admit';
const workerKey = 'integration.symmy.execute-fixture';
const workerPartyRequirement = 'integration.symmy.requirement.worker-party';
const admissionPartyRequirement = 'integration.symmy.requirement.admission-party';
const workerRecoveryRequirement = 'integration.symmy.requirement.worker-recovery';
const admissionRecoveryRequirement = 'integration.symmy.requirement.admission-recovery';
const admissionTenantRecoveryRequirement = 'integration.symmy.requirement.admission-tenant-recovery';
const forbiddenRecoveryWriteRequirement = 'integration.symmy.requirement.admission-recovery-write';
const targetKey = 'party.registry.api.source-result';
const targetCapability = 'party.registry.source-result.read';
const targetWorkload = 'party.registry.source-result';
const privacyKey = 'privacy.core.api.source-processing-eligibility';
const organizationBusinessKey = 'privacy.core.api.organization-business-applicability';
const organizationBusinessCapability = 'privacy.core.organization-business-applicability.read';
const organizationBusinessWorkload = 'privacy.core.organization-business-check';
const organizationBusinessRequirement = 'party.registry.requirement.organization-business';
const sourceFactsKey = 'integration.symmy.api.symmy-source-organization-facts';
const sourceFactsCapability = 'integration.symmy.symmy-source-organization-facts.read';
const sourceFactsWorkload = 'integration.symmy.source-organization-facts.read';
const sourceFactsRequirement = 'privacy.core.requirement.organization-business-source-facts';
const sourceFactsVersion = '2';
const privacyProviderKey = 'native-privacy-module-credential';
const organizationBusinessEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: organizationBusinessKey,
  moduleKey: 'privacy.core',
  role: 'api',
});
const sourceFactsEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: sourceFactsKey,
  moduleKey: sourceModule,
  role: 'api',
});

const privacyCapability = 'privacy.core.source-processing-eligibility.read';
const privacyTenantKey = 'privacy.core.api.tenant-check';
const privacyTenantCapability = 'privacy.core.tenant-check.read';
const privacyTenantEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: privacyTenantKey,
  moduleKey: 'privacy.core',
  role: 'api',
});
const privacyWorkload = 'privacy.core.source-processing-check';
const privacyRequirement = 'party.registry.requirement.source-processing';
const privacyTenantRequirement = 'party.registry.requirement.tenant-check';
const privacyRecoveryRequirement = 'party.registry.requirement.recovery-processing';
const partyProviderKey = 'native-party-module-credential';
const privacyEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: privacyKey,
  moduleKey: 'privacy.core',
  role: 'api',
});
const originalWriteKey = 'party.registry.source-write';
const originalWriteCapability = 'party.registry.source.write';
const originalTenantWriteKey = 'party.registry.source-create';
const recoveryKey = 'party.registry.api.source-recovery';
const recoveryCapability = 'party.registry.source-recovery.read';
const recoveryTenantKey = 'party.registry.api.source-recovery-tenant';
const recoveryTenantCapability = 'party.registry.source-recovery-tenant.read';
const recoveryWorkload = 'party.registry.source-recovery';
const recoveryEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: recoveryKey,
  moduleKey: 'party.registry',
  role: 'api',
});
const recoveryTenantEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: recoveryTenantKey,
  moduleKey: 'party.registry',
  role: 'api',
});
const originalWriteEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: originalWriteKey,
  moduleKey: 'party.registry',
  role: 'action',
});
const originalTenantWriteEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: originalTenantWriteKey,
  moduleKey: 'party.registry',
  role: 'action',
});
const recoveryDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  key: recoveryCapability,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'recovery', level: 'basic' },
  risk: 'routine',
  selectors: [],
});
const recoveryTenantDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  ...recoveryDeclaration,
  key: recoveryTenantCapability,
});
const recoveryAccessWorkload = Schema.decodeUnknownSync(AccessWorkloadSchema)({
  reason: 'Exact historical owner receipt reads',
  workloads: [recoveryWorkload],
});
const targetOperation = { entrypointKey: targetKey, schemaVersion: '1' };
const fixtureSupportedStates = ['inactive', 'active', 'read_only', 'quarantined'] as const;
const providerKey = 'native-module-credential';
const authenticationNamespaceId = 'test.staff.better-auth.v1';

const targetEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: targetKey,
  moduleKey: 'party.registry',
  role: 'api',
});
const targetDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  key: targetCapability,
  kind: 'read' as const,
  modes: ['run' as const],
  placement: { group: 'source-result', level: 'basic' as const },
  risk: 'routine' as const,
  selectors: [],
});
const targetAccessWorkload = Schema.decodeUnknownSync(AccessWorkloadSchema)({
  reason: 'Exact native receiver fixture',
  workloads: [targetWorkload],
});
const originalActionContract = (tenantOnly = false) => ({
  accessDeclaration: {
    key: originalWriteCapability,
    kind: 'action',
    modes: ['run'],
    placement: { group: 'source-write', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  accessWorkload: { reason: 'Fixture native owner writes', workloads: [targetWorkload] },
  actionKey: tenantOnly ? originalTenantWriteKey : originalWriteKey,
  auditProfile: 'standard',
  entrypoint: tenantOnly ? originalTenantWriteEntrypoint : originalWriteEntrypoint,
  idempotency: 'required',
  legalEntityScope: tenantOnly ? 'forbidden' : 'required',
  owningModuleId: 'party.registry',
  schemaVersion: '1',
});

const privacyDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  ...targetDeclaration,
  key: privacyCapability,
});
const privacyTenantDeclaration = Schema.decodeUnknownSync(AccessDeclarationSchema)({
  ...privacyDeclaration,
  key: privacyTenantCapability,
});
const privacyAccessWorkload = Schema.decodeUnknownSync(AccessWorkloadSchema)({
  reason: 'Exact downstream Privacy receipt evidence',
  workloads: [privacyWorkload],
});

const tamperWorkloadClaim = (token: string, replacementToken: string): string => {
  const [header, , signature] = token.split('.');
  const claims = { ...decodeJwt(token), workload: decodeJwt(replacementToken)['workload'] };
  return `${header ?? ''}.${Base64Url.encode(new TextEncoder().encode(JSON.stringify(claims)))}.${signature ?? ''}`;
};

const processingRuntimeFixture = (
  calls: { actions: number; reads: number },
  requirements: typeof OntosModuleRequirementsSchema.Type,
) => {
  const read = defineRead(
    {
      accessActor: Schema.decodeUnknownSync(AccessActorSchema)({
        callers: ['privacy'],
        reason: 'Exact processing native receiver',
        subject: 'identity',
        subjectWorkloads: [sourceFactsWorkload],
      }),
      accessDeclaration: {
        key: sourceFactsCapability,
        kind: 'read',
        modes: ['run'],
        placement: { group: 'source-facts', level: 'basic' },
        risk: 'sensitive',
        selectors: [],
      },
      accessKind: 'detail',
      accessWorkload: {
        reason: 'Exact processing facts',
        requestPurpose: 'PROCESSING',
        workloads: [sourceFactsWorkload],
      },
      entrypoint: sourceFactsEntrypoint,
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'integration.symmy.native-processing-read' },
      inputSchema: SymmySourceOrganizationFactsRequestSchema,
      legalEntityScope: 'required',
      owningModuleKey: sourceModule,
      policies: [],
      readKey: sourceFactsKey,
      resultSchema: SymmySourceOrganizationFactsResponseSchema,
      schemaVersion: sourceFactsVersion,
    },
    () =>
      Effect.sync(() => {
        calls.reads += 1;
        return { evidence: { resultCount: 0 }, result: { outcome: 'NOT_CURRENT' as const } };
      }),
    () => Effect.succeed({}),
  );
  const probeActionKey = 'integration.symmy.native-processing-readonly-probe';
  const action = defineAction(
    {
      accessDeclaration: {
        key: 'integration.symmy.native-processing-readonly-probe.execute',
        kind: 'action',
        modes: ['run'],
        placement: { group: 'processing-probe', level: 'basic' },
        risk: 'routine',
        selectors: [],
      },
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'integration.symmy.native-processing-action' },
      actionKey: probeActionKey,
      auditProfile: 'standard',
      domainErrorSchema: GatewayDelegationSourceError,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: probeActionKey,
        moduleKey: sourceModule,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: sourceModule,
      payloadSchema: Schema.Struct({}),
      policies: [],
      resultSchema: Schema.Struct({ value: Schema.String }),
      schemaVersion: '1',
    },
    () =>
      Effect.sync(() => {
        calls.actions += 1;
        return { value: 'must-not-run' };
      }),
  );
  const admissionAction = defineAction(
    {
      ...action.descriptor,
      actionKey: sourceAction,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: sourceAction,
        moduleKey: sourceModule,
        role: 'action',
      }),
    },
    () => Effect.succeed({ value: 'fixture-admission-never-executed-here' }),
  );
  const worker = defineOutboxWorker(
    {
      consumerModuleKey: sourceModule,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        authorization: { kind: 'owner_local_background' },
        entrypointKey: workerKey,
        moduleKey: sourceModule,
        role: 'worker',
      }),
      leaseDurationMs: 30_000,
      legalEntityScope: 'required',
      payloadSchema: SymmyJobPayloadSchema,
      producerModuleKey: sourceModule,
      retryPolicy: { initialBackoffMs: 1000, maxAttempts: 8, maxBackoffMs: 4000, multiplier: 2 },
      topic: outboxTopic,
      workerKey,
    },
    () => Effect.void,
  );
  const base = makeModuleContractFixture({
    appId: sourceApp,
    moduleId: sourceModule,
    supportedStates: fixtureSupportedStates,
  });
  const manifest = defineOntosModuleManifest({
    ...base.manifest,
    publicSurface: {
      ...base.manifest.publicSurface,
      actions: [action, admissionAction],
      api: { 'symmy-source-organization-facts': SymmySourceOrganizationFactsApi },
      components: {},
      operationContracts: [
        {
          apiKey: 'symmy-source-organization-facts',
          operationKey: 'symmySourceOrganizationFacts.execute',
          registration: read,
        },
      ],
    },
    requirements,
  });
  return {
    action,
    owner: defineVerticalRuntimeRegistration({
      actions: [action, admissionAction],
      manifest,
      outboxWorkers: [worker],
      reads: [read],
    }),
    probeActionKey,
    read,
  };
};

// The registered-workload calls of the three calling modules, verbatim from origin/main 5608aae1d
// apps/shell-super-app/tests/integration/registered-workload-gateway-native.test.ts (then its ONTOS_GATEWAY_MODULE_BINDINGS);
// each calling module now declares them in its own contract (demo divergence exception 8).
const rule = {
  audience: 'party-registry',
  declarationKey: targetCapability,
  entrypointKey: targetKey,
  jobKey: workerKey,
  legalEntityScope: 'required',
  schemaVersion: '1',
  workloadKey: targetWorkload,
} as const;
const recoveryRule = {
  audience: 'party-registry',
  declarationKey: recoveryCapability,
  entrypointKey: recoveryKey,
  jobKey: 'integration.fixture.recovery',
  legalEntityScope: 'required',
  recoveryOf: { actionKey: originalWriteKey, jobKey: workerKey },
  schemaVersion: '1',
  workloadKey: recoveryWorkload,
} as const;
const recoveryTenantRule = {
  ...recoveryRule,
  declarationKey: recoveryTenantCapability,
  entrypointKey: recoveryTenantKey,
  legalEntityScope: 'forbidden',
  recoveryOf: { actionKey: originalTenantWriteKey, jobKey: workerKey },
} as const;
const privacyNormalRule = {
  audience: 'privacy',
  declarationKey: privacyCapability,
  entrypointKey: privacyKey,
  jobKey: 'party-privacy-check',
  legalEntityScope: 'required',
  schemaVersion: '1',
  sourceWorkloadKey: targetWorkload,
  workloadKey: privacyWorkload,
} as const;
const privacyRecoveryRule = {
  ...privacyNormalRule,
  allowRecoverySource: true,
  jobKey: 'party-privacy-recovery-check',
  sourceWorkloadKey: recoveryWorkload,
} as const;
const sourceCalls = [
  { ...rule, sourceActionKey: sourceAction },
  { ...rule, workerKey },
  { ...rule, declarationKey: originalWriteCapability, entrypointKey: originalWriteKey, sourceActionKey: sourceAction },
  { ...rule, declarationKey: originalWriteCapability, entrypointKey: originalWriteKey, workerKey },
  { ...recoveryRule, sourceActionKey: sourceAction },
  { ...recoveryRule, allowHistoricalDeliveryRecovery: true, workerKey },
  { ...recoveryTenantRule, sourceActionKey: sourceAction },
  { ...recoveryTenantRule, workerKey },
];
const partyCalls = [
  {
    ...privacyNormalRule,
    declarationKey: organizationBusinessCapability,
    entrypointKey: organizationBusinessKey,
    workloadKey: organizationBusinessWorkload,
  },
  privacyNormalRule,
  { ...privacyNormalRule, allowRecoverySource: true },
  {
    audience: 'privacy',
    declarationKey: privacyTenantCapability,
    entrypointKey: privacyTenantKey,
    jobKey: 'party-privacy-tenant-check',
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    sourceWorkloadKey: targetWorkload,
    workloadKey: privacyWorkload,
  },
  { ...privacyRecoveryRule, allowRecoverySource: false },
  privacyRecoveryRule,
];
const privacyCalls = [
  {
    audience: sourceApp,
    declarationKey: sourceFactsCapability,
    entrypointKey: sourceFactsKey,
    jobKey: 'privacy.core.organization-business-source-facts',
    legalEntityScope: 'required',
    schemaVersion: sourceFactsVersion,
    sourceWorkloadKey: organizationBusinessWorkload,
    workloadKey: sourceFactsWorkload,
  },
];
/** What a receiving operation publishes about the registered workloads it admits. */
const carrier = (declarationKey: string, workload: string) => ({ declarationKey, workloads: [workload] });

const contractInputs = () => {
  const source = makeModuleContractFixture({
    appId: sourceApp,
    moduleId: sourceModule,
    originatorActions: [sourceAction],
    outboxSubscriptions: [
      {
        consumerModuleKey: sourceModule,
        entrypoint: defineTenantModuleEntrypoint({
          access: 'background',
          authorization: { kind: 'owner_local_background' },
          entrypointKey: workerKey,
          moduleKey: sourceModule,
          role: 'worker',
        }),
        producerModuleKey: sourceModule,
        topic: outboxTopic,
        workerKey,
      },
    ],
    supportedStates: fixtureSupportedStates,
  });
  const destination = makeModuleContractFixture({
    appId: 'party-registry',
    moduleId: 'party.registry',
    supportedStates: fixtureSupportedStates,
  });
  const privacy = makeModuleContractFixture({
    appId: 'privacy',
    moduleId: 'privacy.core',
    supportedStates: fixtureSupportedStates,
  });
  return [
    {
      ...source,
      manifest: {
        ...source.manifest,
        publicSurface: {
          ...source.manifest.publicSurface,
          actions: [
            {
              accessWorkload: { reason: 'Fixture integration admission', workloads: [sourceWorkload] },
              actionKey: sourceAction,
              auditProfile: 'standard',
              entrypoint: defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: sourceAction,
                moduleKey: sourceModule,
                role: 'action',
              }),
              idempotency: 'required',
              legalEntityScope: 'optional',
              owningModuleId: sourceModule,
              schemaVersion: '1',
            },
          ],
          api: [
            {
              key: 'integration.symmy.symmy-source-organization-facts',
              operationKeys: ['symmySourceOrganizationFacts.execute'],
            },
          ],
          operationContracts: [
            {
              apiKey: 'integration.symmy.symmy-source-organization-facts',
              entrypoint: sourceFactsEntrypoint,
              operationKey: 'symmySourceOrganizationFacts.execute',
              schemaVersion: sourceFactsVersion,
              workloadCarrier: carrier(sourceFactsCapability, sourceFactsWorkload),
            },
          ],
          resourceTypes: [importJobResourceDescriptor],
        },
        registeredWorkloadCalls: sourceCalls,
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [
            {
              moduleId: 'party.registry',
              requiredOperations: [
                targetKey,
                recoveryKey,
                recoveryTenantKey,
                originalWriteKey,
                originalTenantWriteKey,
              ].map((entrypointKey) => ({ entrypointKey, schemaVersion: '1' })),
            },
          ],
          operations: [
            {
              condition: 'integration.symmy.condition.worker-recovery',
              entrypointKey: workerKey,
              evidence: ['integration.symmy.evidence.original-owner-receipt'],
              key: workerRecoveryRequirement,
              provider: { entrypointKey: recoveryKey, moduleId: 'party.registry', schemaVersion: '1' },
            },
            {
              condition: 'integration.symmy.condition.admission-recovery',
              entrypointKey: sourceAction,
              evidence: ['integration.symmy.evidence.original-admission-receipt'],
              key: admissionRecoveryRequirement,
              provider: { entrypointKey: recoveryKey, moduleId: 'party.registry', schemaVersion: '1' },
            },
            {
              condition: 'integration.symmy.condition.admission-tenant-recovery',
              entrypointKey: sourceAction,
              evidence: ['integration.symmy.evidence.original-tenant-receipt'],
              key: admissionTenantRecoveryRequirement,
              provider: { entrypointKey: recoveryTenantKey, moduleId: 'party.registry', schemaVersion: '1' },
            },
            {
              condition: 'integration.symmy.condition.admission-recovery-write',
              entrypointKey: sourceAction,
              evidence: ['integration.symmy.evidence.write-is-forbidden'],
              key: forbiddenRecoveryWriteRequirement,
              provider: { entrypointKey: originalWriteKey, moduleId: 'party.registry', schemaVersion: '1' },
            },
            {
              condition: 'integration.symmy.condition.worker-party',
              entrypointKey: workerKey,
              evidence: ['integration.symmy.evidence.current-job'],
              key: workerPartyRequirement,
              provider: { entrypointKey: targetKey, moduleId: 'party.registry', schemaVersion: '1' },
            },
            {
              condition: 'integration.symmy.condition.admission-party',
              entrypointKey: sourceAction,
              evidence: ['integration.symmy.evidence.current-admission'],
              key: admissionPartyRequirement,
              provider: { entrypointKey: targetKey, moduleId: 'party.registry', schemaVersion: '1' },
            },
          ],
          schemaVersion: '1',
        },
      },
    },
    {
      ...destination,
      manifest: {
        ...destination.manifest,
        publicSurface: {
          ...destination.manifest.publicSurface,
          actions: [originalActionContract(), originalActionContract(true)],
          api: [
            {
              key: 'party.registry.source-result',
              operationKeys: [
                'sourceResult.execute',
                'sourceWrite.execute',
                'sourceCreate.execute',
                'sourceRecovery.execute',
                'sourceRecoveryTenant.execute',
              ],
            },
          ],
          operationContracts: [
            {
              apiKey: 'party.registry.source-result',
              entrypoint: targetEntrypoint,
              operationKey: 'sourceResult.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(targetCapability, targetWorkload),
            },
            {
              apiKey: 'party.registry.source-result',
              entrypoint: originalWriteEntrypoint,
              operationKey: 'sourceWrite.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(originalWriteCapability, targetWorkload),
            },
            {
              apiKey: 'party.registry.source-result',
              entrypoint: originalTenantWriteEntrypoint,
              operationKey: 'sourceCreate.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(originalWriteCapability, targetWorkload),
            },
            {
              apiKey: 'party.registry.source-result',
              entrypoint: recoveryEntrypoint,
              operationKey: 'sourceRecovery.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(recoveryCapability, recoveryWorkload),
            },
            {
              apiKey: 'party.registry.source-result',
              entrypoint: recoveryTenantEntrypoint,
              operationKey: 'sourceRecoveryTenant.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(recoveryTenantCapability, recoveryWorkload),
            },
          ],
        },
        registeredWorkloadCalls: partyCalls,
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [],
          operations: [
            {
              condition: 'party.registry.condition.organization-business',
              entrypointKey: targetKey,
              evidence: ['party.registry.evidence.organization-source'],
              key: organizationBusinessRequirement,
              provider: { entrypointKey: organizationBusinessKey, moduleId: 'privacy.core', schemaVersion: '1' },
            },
            {
              condition: 'party.registry.condition.source-processing',
              entrypointKey: targetKey,
              evidence: ['party.registry.evidence.current-source'],
              key: privacyRequirement,
              provider: { entrypointKey: privacyKey, moduleId: 'privacy.core', schemaVersion: '1' },
            },
            {
              condition: 'party.registry.condition.tenant-check',
              entrypointKey: targetKey,
              evidence: ['party.registry.evidence.current-source'],
              key: privacyTenantRequirement,
              provider: { entrypointKey: privacyTenantKey, moduleId: 'privacy.core', schemaVersion: '1' },
            },
            {
              condition: 'party.registry.condition.recovery-processing',
              entrypointKey: recoveryKey,
              evidence: ['party.registry.evidence.exact-original-owner'],
              key: privacyRecoveryRequirement,
              provider: { entrypointKey: privacyKey, moduleId: 'privacy.core', schemaVersion: '1' },
            },
          ],
          schemaVersion: '1',
        },
      },
    },
    {
      ...privacy,
      manifest: {
        ...privacy.manifest,
        publicSurface: {
          ...privacy.manifest.publicSurface,
          api: [
            {
              key: 'privacy.core.source-processing-eligibility',
              operationKeys: [
                'sourceProcessingEligibility.execute',
                'tenantCheck.execute',
                'organizationBusinessApplicability.execute',
              ],
            },
          ],
          operationContracts: [
            {
              apiKey: 'privacy.core.source-processing-eligibility',
              entrypoint: organizationBusinessEntrypoint,
              operationKey: 'organizationBusinessApplicability.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(organizationBusinessCapability, organizationBusinessWorkload),
            },
            {
              apiKey: 'privacy.core.source-processing-eligibility',
              entrypoint: privacyEntrypoint,
              operationKey: 'sourceProcessingEligibility.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(privacyCapability, privacyWorkload),
            },
            {
              apiKey: 'privacy.core.source-processing-eligibility',
              entrypoint: privacyTenantEntrypoint,
              operationKey: 'tenantCheck.execute',
              schemaVersion: '1',
              workloadCarrier: carrier(privacyTenantCapability, privacyWorkload),
            },
          ],
        },
        registeredWorkloadCalls: privacyCalls,
        requirements: {
          coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
          intrinsic: [],
          operations: [
            {
              condition: 'privacy.core.condition.organization-business-source-facts',
              entrypointKey: organizationBusinessKey,
              evidence: ['privacy.core.evidence.current-organization-source'],
              key: sourceFactsRequirement,
              provider: { entrypointKey: sourceFactsKey, moduleId: sourceModule, schemaVersion: sourceFactsVersion },
            },
          ],
          schemaVersion: '1',
        },
      },
    },
  ];
};

const replaceIdentity = (connectionString: string, role: string) => {
  const url = new URL(connectionString);
  url.username = role;
  url.password = role;
  return url.href;
};
const unavailableHumanPort = () => Effect.die('A workload decision must not ask human intent or the tuple engine');

const nativeMachineGate = (database: Effect.Success<ReturnType<typeof makeCoreDatabase>>) =>
  makeAccessDecisionService({
    authorityFor: () => ({
      readCells: unavailableHumanPort,
      // Every company this fixture names is the fixture Tenant's own.
      readCompanyOwnership: () => Effect.succeed(true),
      readConnection: unavailableHumanPort,
      readScope: unavailableHumanPort,
      readTeamIds: unavailableHumanPort,
    }),
    check: { checkBulk: unavailableHumanPort },
    decisionLog: { record: unavailableHumanPort },
    legalEntities: { listCandidateIds: unavailableHumanPort },
    principalKinds: makeDrizzleAccessPrincipalKinds({ ...database, enrollment: SHELL_DATABASE_IDENTITY_ENROLLMENT }),
    workloadBindings: makeDrizzleAccessWorkloadBindings({
      ...database,
      enrollment: SHELL_DATABASE_IDENTITY_ENROLLMENT,
    }),
  });

const nativeRedemption = (database: Effect.Success<ReturnType<typeof makeCoreDatabase>>) => ({
  consume: Effect.fn('NativeRegisteredGateway.redeem')(function* redeem(redemption: GatewayAssertionRedemptionInput) {
    const rows = yield* database.executor
      .execute(
        sql`insert into public.registered_gateway_redemptions(issuer,audience,jti) values(${redemption.issuer},${redemption.audience},${redemption.jti}::uuid) on conflict do nothing returning jti`,
        'objects',
      )
      .pipe(
        Effect.mapError(
          () => new GatewayAssertionRedemptionUnavailableError({ reason: 'Native receiver redemption is unavailable' }),
        ),
      );
    if (rows.length !== 1) {
      return yield* new GatewayAssertionReplayError({ reason: 'Native receiver already redeemed this assertion' });
    }
    return yield* Effect.void;
  }),
});

/** The reason a delegated issuance was refused with, or `issued`. */
const refusalOf = <A, R>(issuance: Effect.Effect<A, unknown, R>) =>
  Effect.exit(issuance).pipe(
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) {
        return 'issued';
      }
      const failure = Cause.squash(exit.cause);
      return Schema.is(GatewayDelegationError)(failure) ? failure.reason : 'other';
    }),
  );

it.live(
  'issues native workload, nested, and exact receipt-recovery capabilities with tenant, actor, binding, and claim restrictions',
  () =>
    Effect.scoped(
      Effect.gen(function* registeredGatewayNative() {
        const crypto = yield* Crypto.Crypto;
        const shellDeployment = { appId: 'shell-super-app', buildMarker: ultramodernDeliveryUnit.buildMarker } as const;
        const snapshot = yield* makeCompositionSnapshot(contractInputs(), 600_000, {
          document: JSON.stringify({
            contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
            coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
            deployment: shellDeployment,
            schemaVersion: '2',
          }),
          receiverDeployment: shellDeployment,
        });
        const fixture = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          // The Shell's enrollment: the clone's trust catalog admits the Shell's gateway audiences for scope grants.
          databaseIdentities: SHELL_DATABASE_IDENTITY_ENROLLMENT,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* makeCoreDatabase(fixture.connections.admin);
        const runtime = yield* makeCoreDatabase(fixture.connections.runtime);
        const partyConfiguration = yield* parseDatabaseConfig({
          DATABASE_URL: replaceIdentity(fixture.connections.runtime.connectionString, 'party_registry_runtime'),
        });
        const party = yield* makeCoreDatabase(partyConfiguration);
        const reactivity = yield* Reactivity.make;
        const issuerClient = yield* PgClient.make({
          url: Redacted.make(replaceIdentity(fixture.connections.runtime.connectionString, 'shell_gateway_issuer')),
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
        const tenantId = yield* crypto.randomUUIDv4();
        const legalEntityId = yield* crypto.randomUUIDv4();
        const otherTenantId = yield* crypto.randomUUIDv4();
        const foreignLegalEntityId = yield* crypto.randomUUIDv4();
        const originalPrincipal = yield* crypto.randomUUIDv4();
        const machinePrincipal = yield* crypto.randomUUIDv4();
        const modulePrincipal = yield* crypto.randomUUIDv4();
        const originalAuthBinding = yield* crypto.randomUUIDv4();
        const moduleAuthBinding = yield* crypto.randomUUIDv4();
        const admissionId = yield* crypto.randomUUIDv4();
        const originalOwnerBinding = yield* crypto.randomUUIDv4();
        const machineBinding = yield* crypto.randomUUIDv4();
        const machineIncarnation = yield* crypto.randomUUIDv4();
        const privacyMachine = yield* crypto.randomUUIDv4();
        const partyModulePrincipal = yield* crypto.randomUUIDv4();
        const privacyOriginalBinding = yield* crypto.randomUUIDv4();
        const privacyMachineBinding = yield* crypto.randomUUIDv4();
        const tenantOperator = yield* crypto.randomUUIDv4();
        const insert = (statement: Parameters<typeof admin.executor.execute>[0]) =>
          admin.executor.execute(statement, 'objects');
        yield* insert(
          sql`insert into core.tenants(tenant_id,slug,name,status,default_locale) values(${tenantId}::uuid,${tenantId},'Gateway native','active','en'),(${otherTenantId}::uuid,${otherTenantId},'Other gateway native','active','en')`,
        );
        yield* insert(
          sql`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${legalEntityId}::uuid,${tenantId}::uuid,'Native company','CZ','1','active'),(${foreignLegalEntityId}::uuid,${otherTenantId}::uuid,'Foreign company','CZ','2','active')`,
        );
        yield* insert(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${originalPrincipal}::uuid,${tenantId}::uuid,'integration','Original integration','active'),(${machinePrincipal}::uuid,${tenantId}::uuid,'system','Receiver system','active'),(${modulePrincipal}::uuid,${tenantId}::uuid,'service','Source deployment','active'),(${tenantOperator}::uuid,${tenantId}::uuid,'human','Tenant operator','active')`,
        );
        yield* insert(
          sql`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${originalAuthBinding}::uuid,${tenantId}::uuid,${originalPrincipal}::uuid,${authenticationNamespaceId},'better_auth','api_key','retired-ingress-key','active'),(${moduleAuthBinding}::uuid,${tenantId}::uuid,${modulePrincipal}::uuid,${authenticationNamespaceId},'better_auth','api_key',${providerKey},'active')`,
        );
        yield* insert(
          sql`update core.principal_auth_bindings set status='revoked',revoked_at=now() where principal_auth_binding_id=${originalAuthBinding}::uuid`,
        );
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${yield* crypto.randomUUIDv4()}::uuid,${tenantId}::uuid,${originalPrincipal}::uuid,${sourceWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active'),(${originalOwnerBinding}::uuid,${tenantId}::uuid,${originalPrincipal}::uuid,${targetWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active'),(${machineBinding}::uuid,${tenantId}::uuid,${machinePrincipal}::uuid,${targetWorkload},${machineIncarnation}::uuid,'active')`,
        );
        yield* insert(
          sql`insert into core.action_invocations(action_invocation_id,tenant_id,legal_entity_id,principal_id,auth_method,auth_binding_id,auth_context_ref,action_key,status,request_hash,started_at,completed_at) values(${admissionId}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${originalPrincipal}::uuid,'api_key',${originalAuthBinding}::uuid,'better-auth-api-key:retired-ingress-key',${sourceAction},'succeeded',${'a'.repeat(64)},now()-interval '400 days',now()-interval '400 days')`,
        );
        yield* insert(
          sql`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId}::uuid,${sourceModule},'active'),(${tenantId}::uuid,'party.registry','active')`,
        );
        yield* insert(
          sql`create table public.registered_gateway_redemptions (issuer text not null, audience text not null, jti uuid not null, primary key(issuer,audience,jti))`,
        );
        yield* insert(
          sql`grant insert,select on public.registered_gateway_redemptions to party_registry_runtime,ontos_runtime`,
        );
        yield* insert(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${privacyMachine}::uuid,${tenantId}::uuid,'system','Privacy system','active'),(${partyModulePrincipal}::uuid,${tenantId}::uuid,'service','Party module','active')`,
        );
        yield* insert(
          sql`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${yield* crypto.randomUUIDv4()}::uuid,${tenantId}::uuid,${partyModulePrincipal}::uuid,${authenticationNamespaceId},'better_auth','api_key',${partyProviderKey},'active')`,
        );
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${privacyOriginalBinding}::uuid,${tenantId}::uuid,${originalPrincipal}::uuid,${privacyWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active'),(${privacyMachineBinding}::uuid,${tenantId}::uuid,${privacyMachine}::uuid,${privacyWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active')`,
        );
        yield* insert(
          sql`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId}::uuid,'privacy.core','active')`,
        );
        const sourceFactsMachine = yield* crypto.randomUUIDv4();
        const privacyModulePrincipal = yield* crypto.randomUUIDv4();
        yield* insert(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${sourceFactsMachine}::uuid,${tenantId}::uuid,'system','Symmy processing source facts','active'),(${privacyModulePrincipal}::uuid,${tenantId}::uuid,'service','Privacy module','active')`,
        );
        yield* insert(
          sql`insert into core.principal_auth_bindings(tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${tenantId}::uuid,${privacyModulePrincipal}::uuid,${authenticationNamespaceId},'better_auth','api_key',${privacyProviderKey},'active')`,
        );
        const sourceFactsMachineBinding = yield* crypto.randomUUIDv4();
        yield* Effect.forEach(
          [
            [originalPrincipal, organizationBusinessWorkload, yield* crypto.randomUUIDv4()],
            [privacyMachine, organizationBusinessWorkload, yield* crypto.randomUUIDv4()],
            [originalPrincipal, sourceFactsWorkload, yield* crypto.randomUUIDv4()],
            [sourceFactsMachine, sourceFactsWorkload, sourceFactsMachineBinding],
          ],
          ([principalId, workload, bindingId]) =>
            Effect.gen(function* enrollProcessingBinding() {
              yield* insert(
                sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${bindingId}::uuid,${tenantId}::uuid,${principalId}::uuid,${workload},${yield* crypto.randomUUIDv4()}::uuid,'active')`,
              );
            }),
          { concurrency: 1, discard: true },
        );
        // One active workload binding acts for one company (D6), so the tenant registers each standalone workload's
        // company through Core's own writers, as the stage and local installers do: the tenant bootstrap creates the
        // tenant's access scopes with their ready fence, and the company registration store ties a workload binding
        // to the company under that fence. The Privacy machine's company is registered where its refusal is proven.
        const workloadAuthority = { enrollment: SHELL_DATABASE_IDENTITY_ENROLLMENT, executor: runtime.executor };
        const operatorScope = yield* stageScopeOf({ principalId: tenantOperator, tenantId });
        yield* writeBootstrapScopes(workloadAuthority, operatorScope, {
          scopes: bootstrapScopesOf(TenantIdSchema.make(tenantId), [LegalEntityIdSchema.make(legalEntityId)]),
          tenantId: TenantIdSchema.make(tenantId),
        });
        const companyRegistrations = makeAccessWorkloadCompanyBindingDrizzleStore(workloadAuthority);
        const registerCompany = (workloadBindingId: string) =>
          Effect.gen(function* registerWorkloadCompany() {
            const companyBindingId = AccessWorkloadCompanyBindingIdSchema.make(yield* crypto.randomUUIDv4());
            yield* companyRegistrations.registerCompanyBindings(operatorScope, {
              bindings: [
                {
                  companyBindingId,
                  createdAt: DateTime.toDateUtc(yield* DateTime.now),
                  incarnation: AccessWorkloadCompanyBindingIdSchema.make(yield* crypto.randomUUIDv4()),
                  legalEntityId: LegalEntityIdSchema.make(legalEntityId),
                  tenantId: TenantIdSchema.make(tenantId),
                  workloadBindingId: AccessWorkloadBindingIdSchema.make(workloadBindingId),
                },
              ],
            });
            return companyBindingId;
          });
        yield* registerCompany(machineBinding);
        yield* registerCompany(originalOwnerBinding);
        yield* registerCompany(sourceFactsMachineBinding);
        // A system principal is the platform's own identity: Core refuses to disable it while its tenant is active, so a
        // machine stops acting only when its workload binding ends (the cases below revoke bindings instead).
        const systemPrincipalDisableRefused = (principalId: string) =>
          Effect.exit(
            insert(sql`update core.principals set status='disabled' where principal_id=${principalId}::uuid`),
          ).pipe(Effect.map(Exit.isFailure));
        const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
        const auth = yield* makeAuthDatabase({
          connectionString: fixture.connections.runtime.connectionString,
          expectedRole: fixture.connections.runtime.expectedRole,
        });
        const scopeResolver = yield* makeOperationalScopeResolver(
          makeOperationalScopeRepository(runtime, SHELL_DATABASE_IDENTITY_ENROLLMENT),
          makeTestOperationalScopeAccess({ decision: 'denied' }),
        );
        const { privateKey, publicKey } = yield* Effect.promise(() =>
          generateKeyPair('Ed25519', { extractable: true }),
        );
        const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
        const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
        const issuer = 'https://native-workload-shell.example';
        const signing = yield* parseGatewayIssuerConfig({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }),
        });
        // The workload rules are no longer configured: the Shell derives them from each calling module's declared
        // workloads and the tenant's actual workload registrations (the access_workload_bindings rows above).
        const configuration = ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
            keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
          }),
        });
        // The Shell verifies a delegated source assertion with its own signing configuration (trunk A2).
        const ownKeyVerification = makeGatewayDelegationVerificationLayer(Effect.succeed(signing));
        const signer = makeGatewayIssuerLayer({
          currentTimeSeconds: Effect.succeed(Math.floor(DateTime.toEpochMillis(snapshot.observedAt) / 1000)),
          generateJti: crypto.randomUUIDv4().pipe(Effect.orDie),
          loadAdmission: Effect.succeed({
            audiences: new Map([
              [sourceApp, `${sourceApp}-build`],
              ['party-registry', 'party-registry-build'],
              ['privacy', 'privacy-build'],
            ]),
            revision: snapshot.composition.revision,
          }),
          loadConfig: Effect.succeed(signing),
        }).pipe(
          Layer.provide(
            Layer.succeed(
              GatewayScopeGrantRegistrar,
              makeGatewayScopeGrantRegistrar(issuerClient, SHELL_DATABASE_IDENTITY_ENROLLMENT),
            ),
          ),
        );
        const services = Layer.mergeAll(
          Layer.succeed(CoreDatabase, runtime),
          Layer.succeed(AccessDecisionGate, nativeMachineGate(runtime)),
          Layer.succeed(AuthDatabase, auth),
          Layer.succeed(PrincipalResolver, makePrincipalResolver(runtime, { authenticationNamespaceId })),
          Layer.succeed(TenantModuleStateService, makeTenantModuleStateService(runtime)),
          Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
          Layer.succeed(GatewayDelegationExchangeLedger, makeGatewayDelegationExchangeLedger(auth.executor)),
          Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
          // The three calling modules' keys were issued by hosts of exactly this release.
          enrolledModuleCredentials(
            (
              [
                [sourceApp, providerKey],
                ['party-registry', partyProviderKey],
                ['privacy', privacyProviderKey],
              ] as const
            ).map(([appId, providerKeyId]) => ({
              appId,
              providerKeyId,
              release: { buildMarker: `${appId}-build`, compositionRevision: snapshot.composition.revision },
            })),
          ),
        );
        const issue = (
          subject: (typeof GatewayDelegatedContextRequestSchema.Encoded)['subject'],
          audience = 'party-registry',
          verifiedProviderKeyId = providerKey,
          legalEntityScope: 'subject' | 'tenant' = 'subject',
          catalog = installed,
        ) =>
          Effect.gen(function* issueNative() {
            const payload = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)({
              audience,
              compositionRevision: snapshot.composition.revision,
              exchangeId: yield* crypto.randomUUIDv4(),
              legalEntityScope,
              subject,
            });
            return yield* issueDelegatedGatewayContextAssertion({
              payload,
              requestCorrelation: 'native-v4-proof',
              verifiedProviderKeyId,
            });
          }).pipe(
            Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
            Effect.provide(signer),
            Effect.provide(ownKeyVerification),
            Effect.provide(GatewayOriginatorEvidenceLive),
            Effect.provideService(OperationalScopeResolver, scopeResolver),
            Effect.provide(services),
            Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          );
        // The same installed release in which one module's contract declares other registered-workload calls (the
        // checked manifest schema refuses repeated or ambiguous calls; `unchecked` models a contract that bypassed it).
        const decodeCheckedCalls = Schema.decodeUnknownSync(OntosRegisteredWorkloadCallsSchema);
        const decodeUncheckedCalls = Schema.decodeUnknownSync(Schema.Array(OntosRegisteredWorkloadCallSchema));
        const replacing = (appId: string, change: (contract: (typeof installed.contracts)[number]) => object) => ({
          ...installed,
          contracts: installed.contracts.map((contract) =>
            contract.deployment.appId === appId ? { ...contract, ...change(contract) } : contract,
          ),
        });
        const declaring = (appId: string, calls: readonly unknown[], decode = decodeCheckedCalls) =>
          replacing(appId, (contract) => ({
            manifest: { ...contract.manifest, registeredWorkloadCalls: decode(calls) },
          }));
        /** The receiver's published operation without the registered workload it admitted. */
        const undeclaredBy = (appId: string, entrypointKey: string) =>
          replacing(appId, (contract) => ({
            manifest: {
              ...contract.manifest,
              publicSurface: {
                ...contract.manifest.publicSurface,
                operationContracts: (contract.manifest.publicSurface.operationContracts ?? []).map((operation) => {
                  if (operation.entrypoint.entrypointKey !== entrypointKey) {
                    return operation;
                  }
                  const { workloadCarrier: _undeclared, ...withoutWorkload } = operation;
                  return withoutWorkload;
                }),
              },
            },
          }));
        const admission = {
          _tag: 'RegisteredAdmission' as const,
          actionInvocationId: admissionId,
          declarationKey: targetCapability,
          expectedAuthContextRef: `job:${workerKey}:run:${admissionId}`,
          expectedPrincipalId: machinePrincipal,
          legalEntityId,
          sourceActionKey: sourceAction,
          tenantId,
        };
        const issued = yield* issue(admission);
        yield* issue({ ...admission, operationRequirementKey: admissionPartyRequirement });
        expect(
          Exit.isFailure(yield* Effect.exit(issue({ ...admission, operationRequirementKey: workerPartyRequirement }))),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue({ ...admission, operationRequirementKey: 'integration.symmy.requirement.unknown' }),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(issue({ ...admission, expectedAuthContextRef: 'job:wrong-owner:run:wrong-run' })),
          ),
        ).toBe(true);
        expect(issued.machineContext).toEqual({
          authContextRef: `job:${workerKey}:run:${admissionId}`,
          bindingIncarnation: machineIncarnation,
          principalId: machinePrincipal,
        });
        const verifier = bindGatewayPrincipalVerifier('party-registry', {
          appId: 'party-registry',
          buildMarker: 'party-registry-build',
        });
        const receive = (token: string) =>
          verifier
            .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
              environment: {
                ONTOS_GATEWAY_ISSUER: issuer,
                ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                  keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
                }),
              },
              redemption: nativeRedemption(party),
            })
            .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
        const verified = yield* receive(issued.token);
        expect(verified.legalEntityId).toBeUndefined();
        expect(Exit.isFailure(yield* Effect.exit(receive(issued.token)))).toBe(true);
        const receiverScopes = yield* makeOperationalScopeResolver(
          makeOperationalScopeRepository(party, SHELL_DATABASE_IDENTITY_ENROLLMENT),
          makeTestOperationalScopeAccess({ decision: 'denied' }),
        );
        const scope = yield* receiverScopes.resolve({
          audience: 'party-registry',
          correlationId: 'native-v4-proof',
          legalEntityScope: 'required',
          principal: verified,
        });
        expect(scope.legalEntityId).toBe(legalEntityId);
        const nestedSubject = {
          _tag: 'RegisteredAssertion' as const,
          declarationKey: privacyCapability,
          expectedPrincipalId: privacyMachine,
          operationRequirementKey: privacyRequirement,
          sourceAssertion: issued.token,
        };
        const nested = yield* issue(nestedSubject, 'privacy', partyProviderKey);
        // The calling module's own contract is the only source of its calls (demo divergence exception 8). One exact
        // call issues, and explicit paired modes are two calls; a repeated mode never passes the contract schema and,
        // carried anyway, is as refused as a wrong mode, workload, declaration or provider version, a receiver that does
        // not declare the workload, or a key whose attested build is not the installed one.
        const nestedWith = (catalog: typeof installed) =>
          refusalOf(issue(nestedSubject, 'privacy', partyProviderKey, 'subject', catalog));
        expect(yield* nestedWith(declaring('party-registry', [privacyNormalRule]))).toBe('issued');
        expect(
          yield* nestedWith(
            declaring('party-registry', [privacyNormalRule, { ...privacyNormalRule, allowRecoverySource: true }]),
          ),
        ).toBe('issued');
        expect(() =>
          decodeCheckedCalls([privacyNormalRule, { ...privacyNormalRule, allowRecoverySource: false }]),
        ).toThrow();
        yield* Effect.forEach(
          [
            [
              declaring(
                'party-registry',
                [privacyNormalRule, { ...privacyNormalRule, allowRecoverySource: false }],
                decodeUncheckedCalls,
              ),
              'registered_workload_unmatched',
            ],
            [
              declaring('party-registry', [{ ...privacyNormalRule, allowRecoverySource: true }]),
              'registered_workload_unmatched',
            ],
            [
              declaring('party-registry', [{ ...privacyNormalRule, workloadKey: 'privacy.core.other-check' }]),
              'registered_workload_unmatched',
            ],
            [
              declaring('party-registry', [{ ...privacyNormalRule, declarationKey: privacyTenantCapability }]),
              'registered_workload_unmatched',
            ],
            [
              declaring('party-registry', [{ ...privacyNormalRule, schemaVersion: '2' }]),
              'registered_workload_unmatched',
            ],
            [undeclaredBy('privacy', privacyKey), 'registered_workload_unmatched'],
            [
              replacing('party-registry', () => ({
                deployment: { appId: 'party-registry', buildMarker: 'party-registry-build-next' },
              })),
              'module_credential_unbound',
            ],
          ] as const,
          ([catalog, reason]) => nestedWith(catalog).pipe(Effect.map((refusal) => expect(refusal).toBe(reason))),
          { discard: true },
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(issue({ ...nestedSubject, sourceAssertion: 'not-a-jwt' }, 'privacy', partyProviderKey)),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue({ ...nestedSubject, recoveryRequestHash: 'e'.repeat(64) }, 'privacy', partyProviderKey),
            ),
          ),
        ).toBe(true);

        const conditionalDenials = [
          { ...nestedSubject, operationRequirementKey: 'party.registry.requirement.undeclared' },
          { ...nestedSubject, operationRequirementKey: privacyRecoveryRequirement },
          { ...nestedSubject, declarationKey: privacyRequirement },
          {
            _tag: 'RegisteredAssertion' as const,
            declarationKey: privacyCapability,
            expectedPrincipalId: privacyMachine,
            sourceAssertion: issued.token,
          },
        ];
        for (const denied of conditionalDenials) {
          expect(Exit.isFailure(yield* Effect.exit(issue(denied, 'privacy', partyProviderKey)))).toBe(true);
        }
        const wrongSourceOperation = yield* issue({ ...admission, declarationKey: originalWriteCapability });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue({ ...nestedSubject, sourceAssertion: wrongSourceOperation.token }, 'privacy', partyProviderKey),
            ),
          ),
        ).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(issue(nestedSubject, 'privacy', partyProviderKey, 'tenant')))).toBe(
          true,
        );
        expect(nested.machineContext?.principalId).toBe(privacyMachine);
        const privacyVerifier = bindGatewayPrincipalVerifier('privacy', {
          appId: 'privacy',
          buildMarker: 'privacy-build',
        });
        const nestedPrincipal = yield* privacyVerifier
          .verifyAndRedeem(Redacted.make(`Bearer ${nested.token}`), {
            environment: {
              ONTOS_GATEWAY_ISSUER: issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
              }),
            },
            redemption: nativeRedemption(runtime),
          })
          .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
        const nestedScope = yield* scopeResolver.resolve({
          audience: 'privacy',
          correlationId: 'native-v4-nested',
          legalEntityScope: 'required',
          principal: nestedPrincipal,
        });
        expect(nestedScope.legalEntityId).toBe(legalEntityId);
        expect(readVerifiedGatewayWorkload(nestedScope)?.originalPrincipalId).toBe(originalPrincipal);
        expect(readVerifiedGatewayWorkload(nestedScope)?.workloadKey).toBe(privacyWorkload);
        const decideNested = () =>
          nativeMachineGate(runtime).decide({
            carrier: {
              accessDeclaration: privacyDeclaration,
              accessWorkload: privacyAccessWorkload,
              entrypoint: privacyEntrypoint,
              schemaVersion: '1',
            },
            legalEntityScope: 'required',
            now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            scope: nestedScope,
          });
        // A verified registered-workload claim is no exemption from the company fence (D6): one active workload
        // binding acts for one company, so until the tenant registers the Privacy machine's company it is refused.
        const unregistered = yield* decideNested();
        expect(unregistered.outcome).toBe('DENIED');
        expect(unregistered.reasons.map((reason) => reason.code)).toEqual(['deny.workload_unbound']);
        const privacyCompany = yield* registerCompany(privacyMachineBinding);
        const registered = yield* decideNested();
        expect(registered.outcome, JSON.stringify(registered.reasons)).toBe('ALLOWED');
        // Ending the registration ends the company of the same verified claim; a re-registration is a fresh row.
        yield* companyRegistrations.revokeCompanyBinding(operatorScope, {
          companyBindingId: privacyCompany,
          revokedAt: DateTime.toDateUtc(yield* DateTime.now),
        });
        const revoked = yield* decideNested();
        expect(revoked.outcome).toBe('DENIED');
        expect(revoked.reasons.map((reason) => reason.code)).toEqual(['deny.workload_unbound']);
        yield* registerCompany(privacyMachineBinding);
        expect((yield* decideNested()).outcome).toBe('ALLOWED');
        const projectedTenant = yield* issue(
          {
            _tag: 'RegisteredAssertion',
            declarationKey: privacyTenantCapability,
            expectedPrincipalId: privacyMachine,
            operationRequirementKey: privacyTenantRequirement,
            sourceAssertion: issued.token,
          },
          'privacy',
          partyProviderKey,
          'tenant',
        );
        const projectedTenantPrincipal = yield* privacyVerifier
          .verifyAndRedeem(Redacted.make(`Bearer ${projectedTenant.token}`), {
            environment: {
              ONTOS_GATEWAY_ISSUER: issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
              }),
            },
            redemption: nativeRedemption(runtime),
          })
          .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
        expect(projectedTenantPrincipal.legalEntityId).toBeUndefined();
        expect(readVerifiedGatewayWorkload(projectedTenantPrincipal)?.legalEntityId).toBeUndefined();
        const projectedTenantScope = yield* scopeResolver.resolve({
          audience: 'privacy',
          correlationId: 'native-nested-tenant-projection',
          legalEntityScope: 'forbidden',
          principal: projectedTenantPrincipal,
        });
        expect(projectedTenantScope.legalEntityId).toBeUndefined();
        expect(
          (yield* nativeMachineGate(runtime).decide({
            carrier: {
              accessDeclaration: privacyTenantDeclaration,
              accessWorkload: privacyAccessWorkload,
              entrypoint: privacyTenantEntrypoint,
              schemaVersion: '1',
            },
            legalEntityScope: 'forbidden',
            now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            scope: projectedTenantScope,
          })).outcome,
        ).toBe('ALLOWED');
        expect(scope.legalEntityId).toBe(legalEntityId);

        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue({ ...nestedSubject, expectedPrincipalId: machinePrincipal }, 'privacy', partyProviderKey),
            ),
          ),
        ).toBe(true);
        const gate = nativeMachineGate(party);
        const decide = (requestScope: typeof scope, operation = targetOperation) =>
          gate.decide({
            carrier: {
              accessDeclaration: targetDeclaration,
              accessWorkload: targetAccessWorkload,
              entrypoint: { ...targetEntrypoint, entrypointKey: operation.entrypointKey },
              schemaVersion: operation.schemaVersion,
            },
            legalEntityScope: 'required',
            now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            scope: requestScope,
          });
        expect((yield* decide(scope)).outcome).toBe('ALLOWED');
        const routeBindingId = yield* crypto.randomUUIDv4();
        const currentRouteKeyId = 'native-current-route-key';
        yield* insert(
          sql`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) values(${routeBindingId}::uuid,${tenantId}::uuid,${originalPrincipal}::uuid,${authenticationNamespaceId},'better_auth','api_key',${currentRouteKeyId},'active')`,
        );
        const routeIdentity = yield* makePrincipalResolver(runtime, {
          authenticationNamespaceId,
        }).resolveBetterAuthApiKey(currentRouteKeyId);
        const routePrincipal = yield* Schema.decodeUnknownEffect(GatewayTrustedPrincipalContextSchema)({
          authBindingId: routeIdentity.authBindingId,
          authContextRef: `better-auth-api-key:${currentRouteKeyId}`,
          authenticationNamespaceId,
          authMethod: 'api_key',
          legalEntityId,
          principalId: routeIdentity.principalId,
          tenantId: routeIdentity.tenantId,
        });
        const routeScopeProof = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
          legalEntityId,
          operations: [{ entrypointKey: targetKey, schemaVersion: '1' }],
          principalId: originalPrincipal,
          routeId: yield* crypto.randomUUIDv4(),
          routeKey: 'native-product-route',
          routeRevision: 'route-1',
          sourceRouteId: yield* crypto.randomUUIDv4(),
          sourceRouteRevision: 'source-1',
          tenantId,
        });
        const namespace = yield* Schema.decodeUnknownEffect(AuthenticationNamespaceRegistrationSchema)({
          allowedAudiences: ['party-registry'],
          authenticationNamespaceId,
          provider: 'better_auth',
          requiresOperationAdmission: false,
          reservationPrincipalKind: 'integration',
          subjectTypes: ['api_key'],
          trustedAttesterPrincipalIds: [],
        });
        const routeRegistry = makeAuthenticationNamespaceRegistry([namespace]);
        const signerServices = yield* Layer.build(signer);
        const plainIssuer = Context.get(signerServices, GatewayIssuer);
        const ordinaryV2 = yield* plainIssuer.issue({
          audience: 'party-registry',
          compositionRevision: snapshot.composition.revision,
          principal: routePrincipal,
        });
        const ordinaryPrincipal = yield* receive(ordinaryV2.token);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              receiverScopes
                .resolve({
                  audience: 'party-registry',
                  correlationId: 'native-ordinary-v2-company',
                  legalEntityScope: 'required',
                  principal: ordinaryPrincipal,
                })
                .pipe(Effect.provideService(AuthenticationNamespaceRegistry, routeRegistry)),
            ),
          ),
        ).toBe(true);
        const routeIssued = yield* issueRouteScopedGatewayContextAssertion({
          audience: 'party-registry',
          compositionRevision: snapshot.composition.revision,
          principal: routePrincipal,
          routeScope: routeScopeProof,
        }).pipe(Effect.provide(signer));
        const verifiedRoutePrincipal = yield* receive(routeIssued.token);
        const verifiedRouteScope = yield* receiverScopes
          .resolve({
            audience: 'party-registry',
            correlationId: 'native-route-v2-company',
            legalEntityScope: 'required',
            principal: verifiedRoutePrincipal,
          })
          .pipe(Effect.provideService(AuthenticationNamespaceRegistry, routeRegistry));
        expect(readVerifiedGatewayRouteScope(verifiedRouteScope)).toEqual(routeScopeProof);
        expect((yield* decide(verifiedRouteScope)).outcome).toBe('ALLOWED');
        const routeBatch = yield* gate.decideMany(
          [
            { entrypointKey: targetKey, schemaVersion: '1' },
            { entrypointKey: 'party.registry.api.other', schemaVersion: '1' },
            { entrypointKey: targetKey, schemaVersion: '2' },
          ].map((operation) => ({
            carrier: {
              accessDeclaration: targetDeclaration,
              accessWorkload: targetAccessWorkload,
              entrypoint: { ...targetEntrypoint, entrypointKey: operation.entrypointKey },
              schemaVersion: operation.schemaVersion,
            },
            legalEntityScope: 'required' as const,
            now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            scope: verifiedRouteScope,
          })),
        );
        expect(routeBatch.map((decision) => decision.outcome)).toEqual(['ALLOWED', 'DENIED', 'DENIED']);

        expect(
          (yield* decide(verifiedRouteScope, { entrypointKey: 'party.registry.api.other', schemaVersion: '1' }))
            .outcome,
        ).toBe('DENIED');
        expect((yield* decide(verifiedRouteScope, { entrypointKey: targetKey, schemaVersion: '2' })).outcome).toBe(
          'DENIED',
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              receiverScopes
                .resolve({
                  audience: 'party-registry',
                  correlationId: 'native-route-copy',
                  legalEntityScope: 'required',
                  principal: { ...verifiedRoutePrincipal },
                })
                .pipe(Effect.provideService(AuthenticationNamespaceRegistry, routeRegistry)),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issueRouteScopedGatewayContextAssertion({
                audience: 'party-registry',
                compositionRevision: snapshot.composition.revision,
                principal: routePrincipal,
                routeScope: { ...routeScopeProof, legalEntityId: foreignLegalEntityId },
              }).pipe(Effect.provide(signer)),
            ),
          ),
        ).toBe(true);

        expect(
          (yield* decide(scope, { entrypointKey: 'party.registry.api.another-read', schemaVersion: '1' })).outcome,
        ).toBe('DENIED');
        expect((yield* decide(scope, { entrypointKey: targetKey, schemaVersion: '2' })).outcome).toBe('DENIED');
        expect(
          Exit.isFailure(yield* Effect.exit(issue({ ...admission, expectedPrincipalId: originalPrincipal }))),
        ).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(issue({ ...admission, legalEntityId: foreignLegalEntityId })))).toBe(
          true,
        );
        expect(yield* systemPrincipalDisableRefused(machinePrincipal)).toBe(true);
        yield* insert(
          sql`update core.access_workload_bindings set status='revoked',revoked_at=now() where binding_id=${originalOwnerBinding}::uuid`,
        );
        expect((yield* decide(scope)).outcome).toBe('DENIED');
        expect(Exit.isFailure(yield* Effect.exit(issue(nestedSubject, 'privacy', partyProviderKey)))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(issue(admission)))).toBe(true);
        const renewedOwnerBinding = yield* crypto.randomUUIDv4();
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${renewedOwnerBinding}::uuid,${tenantId}::uuid,${originalPrincipal}::uuid,${targetWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active')`,
        );
        yield* registerCompany(renewedOwnerBinding);
        const renewedSource = yield* issue(admission);
        const renewedNestedSubject = { ...nestedSubject, sourceAssertion: renewedSource.token };
        yield* issue(renewedNestedSubject, 'privacy', partyProviderKey);
        yield* insert(
          sql`update core.access_workload_bindings set status='revoked',revoked_at=now() where binding_id=${privacyOriginalBinding}::uuid`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(renewedNestedSubject, 'privacy', partyProviderKey)))).toBe(true);
        const eventId = yield* crypto.randomUUIDv4();
        const messageId = yield* crypto.randomUUIDv4();
        const deliveryId = yield* crypto.randomUUIDv4();
        const historicalJobId = yield* crypto.randomUUIDv4();
        yield* insert(
          sql`insert into core.domain_events(domain_event_id,tenant_id,legal_entity_id,action_invocation_id,producer_module_key,event_type,subject_module_key,subject_resource_type,subject_resource_id,payload_json) values(${eventId}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${admissionId}::uuid,${sourceModule},${outboxTopic},${sourceModule},${importJobResourceDescriptor.key},${historicalJobId},${JSON.stringify({ jobId: historicalJobId })}::jsonb)`,
        );
        yield* insert(
          sql`insert into core.outbox_messages(outbox_message_id,tenant_id,domain_event_id,producer_module_key,topic,payload_json) values(${messageId}::uuid,${tenantId}::uuid,${eventId}::uuid,${sourceModule},${outboxTopic},${JSON.stringify({ jobId: historicalJobId })}::jsonb)`,
        );
        yield* insert(
          sql`insert into core.outbox_deliveries(outbox_delivery_id,outbox_message_id,worker_key,consumer_module_key,status,claimed_by,claimed_at,claim_expires_at) values(${deliveryId}::uuid,${messageId}::uuid,${workerKey},${sourceModule},'processing','native-claim',now(),now()+interval '30 seconds')`,
        );
        const conditionalWorker = {
          _tag: 'RegisteredWorkload' as const,
          claimId: 'native-claim',
          declarationKey: targetCapability,
          deliveryId,
          expectedPrincipalId: machinePrincipal,
          legalEntityId,
          operationRequirementKey: workerPartyRequirement,
          tenantId,
          workerKey,
        };
        const worker = yield* issue(conditionalWorker);
        expect(
          yield* refusalOf(
            issue(
              conditionalWorker,
              'party-registry',
              providerKey,
              'subject',
              declaring(sourceApp, [{ ...rule, schemaVersion: '2', workerKey }]),
            ),
          ),
        ).toBe('registered_workload_unmatched');
        expect(
          Exit.isFailure(
            yield* Effect.exit(issue({ ...conditionalWorker, operationRequirementKey: admissionPartyRequirement })),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue({ ...conditionalWorker, operationRequirementKey: 'integration.symmy.requirement.unknown' }),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(issue({ ...conditionalWorker, workerKey: `${workerKey}.sibling` }))),
        ).toBe(true);
        const workerPrincipal = yield* receive(worker.token);
        const workerScope = yield* receiverScopes.resolve({
          audience: 'party-registry',
          correlationId: 'native-v4-worker',
          legalEntityScope: 'required',
          principal: workerPrincipal,
        });
        expect((yield* decide(workerScope)).outcome).toBe('ALLOWED');
        const processingDecision = yield* Effect.gen(function* proveOrganizationProcessing() {
          const organizationBusiness = yield* issue(
            {
              _tag: 'RegisteredAssertion',
              declarationKey: organizationBusinessCapability,
              expectedPrincipalId: privacyMachine,
              operationRequirementKey: organizationBusinessRequirement,
              sourceAssertion: worker.token,
            },
            'privacy',
            partyProviderKey,
          );
          const organizationBusinessPrincipal = yield* privacyVerifier
            .verifyAndRedeem(Redacted.make(`Bearer ${organizationBusiness.token}`), {
              environment: {
                ONTOS_GATEWAY_ISSUER: issuer,
                ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                  keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
                }),
              },
              redemption: nativeRedemption(runtime),
            })
            .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
          expect(readVerifiedGatewayWorkload(organizationBusinessPrincipal)?.entrypointKey).toBe(
            organizationBusinessKey,
          );
          const processingRequest = yield* Schema.decodeUnknownEffect(
            SymmySourceOrganizationFactsProcessingSelectorSchema,
          )({
            effectId: yield* crypto.randomUUIDv4(),
            originalAdmissionInvocationId: admissionId,
            purpose: 'PROCESSING',
          });
          const processingSubject = {
            _tag: 'RegisteredAssertion' as const,
            declarationKey: sourceFactsCapability,
            expectedPrincipalId: sourceFactsMachine,
            operationRequirementKey: sourceFactsRequirement,
            processingRequestHash: computeCanonicalValueHash(processingRequest),
            sourceAssertion: organizationBusiness.token,
          };
          const { processingRequestHash: _processingHash, ...missingProcessingHash } = processingSubject;
          expect(Exit.isFailure(yield* Effect.exit(issue(missingProcessingHash, sourceApp, privacyProviderKey)))).toBe(
            true,
          );
          yield* Effect.gen(function* proveOpaqueProcessingEvidence() {
            const bindings = yield* loadGatewayModuleBindings;
            const binding = Option.getOrThrow(
              Option.fromNullishOr(bindings.find((candidate) => candidate.providerKeyId === privacyProviderKey)),
            );
            const currentDate = yield* DateTime.nowAsDate;
            const admittedSource = yield* admitAssertionSubject({
              assertion: Redacted.make(organizationBusiness.token),
              binding,
              currentDate,
              now: Math.floor(currentDate.getTime() / 1000),
              registeredWorkload: true,
              requestedCompositionRevision: snapshot.composition.revision,
            });
            const sourceEvidence = Option.getOrThrow(
              Option.fromNullishOr(readVerifiedGatewayAssertion(admittedSource.verifiedAssertion)),
            );
            expect(Object.isFrozen(admittedSource.sourceValidity)).toBe(true);
            expect(
              Reflect.set(admittedSource.sourceValidity, 'expiresAt', admittedSource.sourceValidity.expiresAt + 86_400),
            ).toBe(false);
            expect(Reflect.set(sourceEvidence.principal, 'principalId', originalPrincipal)).toBe(false);
            const sourceWorkloadEvidence = Option.getOrThrow(Option.fromNullishOr(sourceEvidence.workload));
            expect(Reflect.set(sourceWorkloadEvidence, 'entrypointKey', targetKey)).toBe(false);
            const decodedSubject = yield* Schema.decodeUnknownEffect(GatewayRegisteredAssertionSubjectSchema)(
              processingSubject,
            );
            const admit = (
              source = admittedSource.verifiedAssertion,
              suppliedBinding = binding,
              suppliedInstalled = installed,
            ) =>
              admitRegisteredAssertionWorkload({
                audience: sourceApp,
                binding: suppliedBinding,
                installed: suppliedInstalled,
                source,
                subject: decodedSubject,
              });
            const copiedSource = structuredClone(admittedSource.verifiedAssertion);
            Object.setPrototypeOf(copiedSource, Object.getPrototypeOf(admittedSource.verifiedAssertion));
            expect(readVerifiedGatewayAssertion(copiedSource)).toBeUndefined();
            expect(Exit.isFailure(yield* Effect.exit(admit(copiedSource)))).toBe(true);
            expect(
              Exit.isFailure(
                yield* Effect.exit(
                  admit(admittedSource.verifiedAssertion, { ...binding, sourceBuildMarker: 'foreign-build' }),
                ),
              ),
            ).toBe(true);
            expect(
              Exit.isFailure(
                yield* Effect.exit(
                  admit(admittedSource.verifiedAssertion, binding, {
                    ...installed,
                    composition: { ...installed.composition, revision: 'f'.repeat(64) },
                  }),
                ),
              ),
            ).toBe(true);
            expect(
              Exit.isFailure(
                yield* Effect.exit(
                  admit(admittedSource.verifiedAssertion, {
                    ...binding,
                    providerKeyId: Option.getOrThrow(
                      Option.fromNullishOr(bindings.find((candidate) => candidate.providerKeyId === partyProviderKey)),
                    ).providerKeyId,
                  }),
                ),
              ),
            ).toBe(true);
            const admitted = yield* admit();
            const witness = Option.getOrThrow(Option.fromNullishOr(admitted.organizationProcessingWitness));
            const copiedWitness = structuredClone(witness);
            Object.setPrototypeOf(copiedWitness, Object.getPrototypeOf(witness));
            expect(takeAdmittedOrganizationProcessingRead(copiedWitness)).toBeUndefined();
            expect(
              Exit.isFailure(yield* Effect.exit(issueOrganizationProcessingReadGatewayContextAssertion(copiedWitness))),
            ).toBe(true);
            const taken = Option.getOrThrow(Option.fromNullishOr(takeAdmittedOrganizationProcessingRead(witness)));
            expect(Reflect.set(taken.sourceValidity, 'expiresAt', taken.sourceValidity.expiresAt + 86_400)).toBe(false);
            expect(Reflect.set(taken.principal, 'principalId', originalPrincipal)).toBe(false);
            expect(Reflect.set(taken.workload, 'entrypointKey', targetKey)).toBe(false);
            expect(
              Exit.isFailure(yield* Effect.exit(issueOrganizationProcessingReadGatewayContextAssertion(witness))),
            ).toBe(true);
            const actualWitness = Option.getOrThrow(
              Option.fromNullishOr((yield* admit()).organizationProcessingWitness),
            );
            const signed = yield* issueOrganizationProcessingReadGatewayContextAssertion(actualWitness);
            expect(decodeJwt(signed.token).exp).toBe(sourceEvidence.sourceValidity.expiresAt);
            expect(
              Exit.isFailure(yield* Effect.exit(issueOrganizationProcessingReadGatewayContextAssertion(actualWitness))),
            ).toBe(true);
          }).pipe(
            Effect.provide(signer),
            Effect.provide(ownKeyVerification),
            Effect.provideService(OperationalScopeResolver, scopeResolver),
            Effect.provide(services),
            Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          );
          const processing = yield* issue(processingSubject, sourceApp, privacyProviderKey);
          expect(
            yield* refusalOf(
              issue(
                processingSubject,
                sourceApp,
                privacyProviderKey,
                'subject',
                declaring('privacy', [{ ...privacyCalls[0], schemaVersion: '1' }]),
              ),
            ),
          ).toBe('registered_workload_unmatched');
          expect(decodeJwt(processing.token).iat).toBe(decodeJwt(organizationBusiness.token).iat);
          expect(decodeJwt(processing.token).exp).toBe(decodeJwt(organizationBusiness.token).exp);
          const processingVerifier = bindGatewayPrincipalVerifier(sourceApp, {
            appId: sourceApp,
            buildMarker: `${sourceApp}-build`,
          });
          const processingPrincipal = yield* processingVerifier
            .verifyAndRedeem(Redacted.make(`Bearer ${processing.token}`), {
              environment: {
                ONTOS_GATEWAY_ISSUER: issuer,
                ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                  keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
                }),
              },
              redemption: nativeRedemption(runtime),
            })
            .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
          const processingScope = yield* scopeResolver.resolve({
            audience: sourceApp,
            correlationId: 'native-organization-processing',
            legalEntityScope: 'required',
            principal: processingPrincipal,
          });
          const processingDeclaration = yield* Schema.decodeUnknownEffect(AccessDeclarationSchema)({
            ...targetDeclaration,
            key: sourceFactsCapability,
          });
          const processingAccessWorkload = yield* Schema.decodeUnknownEffect(AccessWorkloadSchema)({
            reason: 'Exact native Privacy organization source read',
            requestPurpose: 'PROCESSING',
            workloads: [sourceFactsWorkload],
          });
          const exactProcessingOperation = { entrypointKey: sourceFactsKey, schemaVersion: sourceFactsVersion };
          const decideProcessing = (operation = exactProcessingOperation) =>
            nativeMachineGate(runtime).decide({
              carrier: {
                accessDeclaration: processingDeclaration,
                accessWorkload: processingAccessWorkload,
                entrypoint: { ...sourceFactsEntrypoint, entrypointKey: operation.entrypointKey },
                schemaVersion: operation.schemaVersion,
              },
              legalEntityScope: 'required',
              now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
              scope: processingScope,
            });
          expect((yield* decideProcessing()).outcome).toBe('ALLOWED');
          const calls = { actions: 0, reads: 0 };
          const receiverFixture = processingRuntimeFixture(
            calls,
            Schema.decodeUnknownSync(OntosModuleRequirementsSchema)(contractInputs().at(0)?.manifest.requirements),
          );
          const ownerProjection = extractVerticalRuntimeSafeDescriptors(receiverFixture.owner);
          expect(ownerProjection.operationContracts).toEqual(
            contractInputs().at(0)?.manifest.publicSurface.operationContracts,
          );
          expect(ownerProjection.requirements).toEqual(contractInputs().at(0)?.manifest.requirements);
          const nativeEnforcement = AccessDecisionLive.pipe(
            Layer.provideMerge(AccessEnforcementPortsLive),
            Layer.provideMerge(TenantIntentLoaderLive),
            Layer.provide(Layer.succeed(CoreDatabase, runtime)),
          );
          const nativePorts = yield* Layer.build(nativeEnforcement);
          const runtimeServices = Layer.mergeAll(
            services,
            Layer.succeedContext(nativePorts),
            Layer.succeed(OperationalScopeResolver, scopeResolver),
            OwnerAuthorizationOverlayAllowLive,
            ContextAccessLive,
            ActionPermissionLive,
            ActionRepositoryLive.pipe(Layer.provide(services)),
            ModuleEntrypointGatewayLive.pipe(Layer.provideMerge(ModuleStateGateLive), Layer.provide(services)),
          );
          const nativeRuntimes = yield* Layer.build(
            Layer.mergeAll(
              makeReadRuntimeLive({ appId: sourceApp, buildMarker: `${sourceApp}-build` }, receiverFixture.owner),
              makeActionRuntimeLive({ appId: sourceApp, buildMarker: `${sourceApp}-build` }, receiverFixture.owner),
            ).pipe(Layer.provide(runtimeServices)),
          );
          const readRuntime = Context.get(nativeRuntimes, ReadRuntime);
          const actionRuntime = Context.get(nativeRuntimes, ActionRuntime);
          const runRead = (
            input: typeof SymmySourceOrganizationFactsRequestSchema.Type,
            principal = processingPrincipal,
          ) =>
            readRuntime.runRead({
              audience: sourceApp,
              input,
              principal,
              registration: receiverFixture.read,
              transport: { correlationId: 'native-processing-read-runtime' },
            });
          expect(yield* runRead(processingRequest)).toEqual({ outcome: 'NOT_CURRENT' });
          expect(calls.reads).toBe(1);
          const changedRequest = yield* Schema.decodeUnknownEffect(
            SymmySourceOrganizationFactsProcessingSelectorSchema,
          )({ ...processingRequest, effectId: yield* crypto.randomUUIDv4() });
          expect(Exit.isFailure(yield* Effect.exit(runRead(changedRequest)))).toBe(true);
          expect(calls.reads).toBe(1);
          const governanceRequest = yield* Schema.decodeUnknownEffect(SymmySourceOrganizationFactsRequestSchema)({
            effectKey: 'native.governance',
            execution: { jobId: historicalJobId, kind: 'JOB' },
            purpose: 'GOVERNANCE',
            sourceReference: {
              occurrenceId: 'native-occurrence',
              recordId: 'native-record',
              source: { issuer: 'native', namespace: 'source', recordType: 'organization', routeRef: 'native-route' },
            },
          });
          const governanceToken = yield* issue(
            { ...processingSubject, processingRequestHash: computeCanonicalValueHash(governanceRequest) },
            sourceApp,
            privacyProviderKey,
          );
          const governancePrincipal = yield* processingVerifier
            .verifyAndRedeem(Redacted.make(`Bearer ${governanceToken.token}`), {
              environment: {
                ONTOS_GATEWAY_ISSUER: issuer,
                ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                  keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
                }),
              },
              redemption: nativeRedemption(runtime),
            })
            .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
          expect(Exit.isFailure(yield* Effect.exit(runRead(governanceRequest, governancePrincipal)))).toBe(true);
          expect(calls.reads).toBe(1);
          const cachedKey = 'native-processing-cached-action';
          const cachedHash = computeActionRequestHash({
            actionKey: receiverFixture.probeActionKey,
            normalizedPayload: {},
            owningModuleKey: sourceModule,
            principal: processingPrincipal,
            schemaVersion: '1',
            target: {},
          });
          yield* insert(
            sql`insert into core.action_invocations(action_invocation_id,tenant_id,legal_entity_id,principal_id,auth_method,auth_context_ref,action_key,idempotency_key,status,request_hash,completed_at) values(${yield* crypto.randomUUIDv4()}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${sourceFactsMachine}::uuid,'system',${processingPrincipal.authContextRef},${receiverFixture.probeActionKey},${cachedKey},'succeeded',${cachedHash},now())`,
          );
          const deniedAction = yield* actionRuntime
            .runAction({
              audience: sourceApp,
              payload: {},
              principal: processingPrincipal,
              registration: receiverFixture.action,
              transport: { correlationId: 'native-processing-readonly', idempotencyKey: cachedKey },
            })
            .pipe(Effect.flip);
          expect(Schema.is(ActionTrustedContextValidationError)(deniedAction)).toBe(true);
          expect(calls.actions).toBe(0);

          expect(readVerifiedGatewayOrganizationProcessingRead(processingScope)).toEqual({
            requestHash: computeCanonicalValueHash(processingRequest),
          });
          expect(readVerifiedGatewayOrganizationProcessingRead({ ...processingScope })).toBeUndefined();
          expect(processingPrincipal.legalEntityId).toBeUndefined();
          expect(processingScope.legalEntityId).toBe(legalEntityId);
          expect(readVerifiedGatewayWorkload(processingScope)?.claimId).toBe('native-claim');
          expect(readVerifiedGatewayWorkload(processingScope)?.originalPrincipalId).toBe(originalPrincipal);
          expect((yield* decideProcessing({ entrypointKey: sourceFactsKey, schemaVersion: '1' })).outcome).toBe(
            'DENIED',
          );
          expect(
            (yield* decideProcessing({ entrypointKey: `${sourceFactsKey}.write`, schemaVersion: sourceFactsVersion }))
              .outcome,
          ).toBe('DENIED');
          for (const denied of [
            { ...processingSubject, operationRequirementKey: 'privacy.core.requirement.unrelated' },
            { ...processingSubject, declarationKey: organizationBusinessCapability },
            { ...processingSubject, sourceAssertion: nested.token },
            { ...processingSubject, operationRequirementKey: organizationBusinessRequirement },
          ]) {
            expect(Exit.isFailure(yield* Effect.exit(issue(denied, sourceApp, privacyProviderKey)))).toBe(true);
          }
          const ordinaryPrivacyActor = yield* Schema.decodeUnknownEffect(GatewayActorClaimSchema)({
            appId: 'party-registry',
            buildMarker: 'party-registry-build',
            principalId: partyModulePrincipal,
          });
          const ordinaryPrivacy = yield* plainIssuer.issue({
            actor: ordinaryPrivacyActor,
            audience: 'privacy',
            compositionRevision: snapshot.composition.revision,
            principal: routePrincipal,
          });
          expect(decodeJwt(ordinaryPrivacy.token)['ver']).toBe(3);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                issue({ ...processingSubject, sourceAssertion: ordinaryPrivacy.token }, sourceApp, privacyProviderKey),
              ),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                plainIssuer.issue({
                  actor: ordinaryPrivacyActor,
                  audience: sourceApp,
                  compositionRevision: snapshot.composition.revision,
                  principal: routePrincipal,
                }),
              ),
            ),
          ).toBe(true);

          return decideProcessing;
        });
        yield* insert(
          sql`update core.outbox_deliveries set claimed_by='replacement-claim' where outbox_delivery_id=${deliveryId}::uuid`,
        );
        expect((yield* processingDecision()).outcome).toBe('DENIED');
        expect((yield* decide(workerScope)).outcome).toBe('DENIED');
        expect(Exit.isFailure(yield* Effect.exit(issue(conditionalWorker)))).toBe(true);
        yield* insert(
          sql`update core.outbox_deliveries set claimed_by='native-claim',claim_expires_at=now()-interval '1 second' where outbox_delivery_id=${deliveryId}::uuid`,
        );
        expect((yield* decide(workerScope)).outcome).toBe('DENIED');
        yield* insert(
          sql`update core.outbox_deliveries set claim_expires_at=now()+interval '30 seconds',status='done' where outbox_delivery_id=${deliveryId}::uuid`,
        );
        expect((yield* decide(workerScope)).outcome).toBe('DENIED');
        expect(readVerifiedGatewayWorkload(workerScope)?.claimId).toBe('native-claim');
        const enrolled = makeSystemPrincipalContextResolver(runtime);
        expect(
          (yield* enrolled.resolveEnrolled({
            registration: registerSystemWorkload({ jobKey: targetWorkload }),
            runReference: admissionId,
            tenantId,
          })).principalId,
        ).toBe(machinePrincipal);
        const otherMachine = yield* crypto.randomUUIDv4();
        yield* insert(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${otherMachine}::uuid,${otherTenantId}::uuid,'system','Other tenant machine','active')`,
        );
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${yield* crypto.randomUUIDv4()}::uuid,${otherTenantId}::uuid,${otherMachine}::uuid,${targetWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active')`,
        );
        expect(
          (yield* enrolled.resolveEnrolled({
            registration: registerSystemWorkload({ jobKey: targetWorkload }),
            runReference: admissionId,
            tenantId: otherTenantId,
          })).principalId,
        ).toBe(otherMachine);
        const ambiguousMachine = yield* crypto.randomUUIDv4();
        const ambiguousBinding = yield* crypto.randomUUIDv4();
        yield* insert(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${ambiguousMachine}::uuid,${tenantId}::uuid,'system','Ambiguous machine','active')`,
        );
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${ambiguousBinding}::uuid,${tenantId}::uuid,${ambiguousMachine}::uuid,${targetWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active')`,
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              enrolled.resolveEnrolled({
                registration: registerSystemWorkload({ jobKey: targetWorkload }),
                runReference: admissionId,
                tenantId,
              }),
            ),
          ),
        ).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(issue(admission)))).toBe(true);
        expect(yield* systemPrincipalDisableRefused(ambiguousMachine)).toBe(true);
        yield* insert(
          sql`update core.access_workload_bindings set status='revoked',revoked_at=now() where binding_id=${ambiguousBinding}::uuid`,
        );
        const beforeRevoke = yield* issue(admission);
        const beforePrincipal = yield* receive(beforeRevoke.token);
        const beforeScope = yield* receiverScopes.resolve({
          audience: 'party-registry',
          correlationId: 'before-machine-revoke',
          legalEntityScope: 'required',
          principal: beforePrincipal,
        });
        yield* insert(
          sql`update core.access_workload_bindings set status='revoked',revoked_at=now() where binding_id=${machineBinding}::uuid`,
        );
        expect((yield* decide(beforeScope)).outcome).toBe('DENIED');
        // The tenant now holds no active registration of the receiving workload: the declared call admits nothing.
        expect(yield* refusalOf(issue(admission))).toBe('workload_binding_not_active');
        // The ambiguous machine is registered again: a fresh binding, with its company.
        const renewedAmbiguousBinding = yield* crypto.randomUUIDv4();
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${renewedAmbiguousBinding}::uuid,${tenantId}::uuid,${ambiguousMachine}::uuid,${targetWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active')`,
        );
        yield* registerCompany(renewedAmbiguousBinding);
        expect(Exit.isFailure(yield* Effect.exit(issue(admission)))).toBe(true);

        const currentWriteAdmission = {
          ...admission,
          declarationKey: originalWriteCapability,
          expectedPrincipalId: ambiguousMachine,
        };
        yield* issue(currentWriteAdmission);
        yield* insert(
          sql`update core.tenant_module_states set state='read_only' where tenant_id=${tenantId}::uuid and module_key='party.registry'`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(currentWriteAdmission)))).toBe(true);
        const backgroundWrite = {
          _tag: 'RegisteredWorkload' as const,
          claimId: 'native-claim',
          declarationKey: originalWriteCapability,
          deliveryId,
          expectedPrincipalId: ambiguousMachine,
          legalEntityId,
          tenantId,
          workerKey,
        };
        yield* insert(
          sql`update core.outbox_deliveries set status='processing',claimed_by='native-claim',claim_expires_at=now()+interval '60 seconds' where outbox_delivery_id=${deliveryId}::uuid`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(backgroundWrite)))).toBe(true);
        // A current independent receipt actor may recover only an exact historical owner invocation,
        // even after the integration and its original write permission have been revoked.
        yield* issue({ ...admission, expectedPrincipalId: ambiguousMachine });
        const recoveryPrincipalId = yield* crypto.randomUUIDv4();
        const recoveryBindingId = yield* crypto.randomUUIDv4();
        const recoveryIncarnation = yield* crypto.randomUUIDv4();
        yield* insert(
          sql`insert into core.principals(principal_id,tenant_id,kind,display_name,status) values(${recoveryPrincipalId}::uuid,${tenantId}::uuid,'system','Independent receipt actor','active')`,
        );
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${recoveryBindingId}::uuid,${tenantId}::uuid,${recoveryPrincipalId}::uuid,${recoveryWorkload},${recoveryIncarnation}::uuid,'active')`,
        );
        yield* registerCompany(recoveryBindingId);
        const originalOwnerInvocation = yield* crypto.randomUUIDv4();
        const originalWorkerInvocation = yield* crypto.randomUUIDv4();
        const originalTenantInvocation = yield* crypto.randomUUIDv4();
        const originalIdempotencyKey = 'native-original-owner-command';
        const originalRequestHash = 'b'.repeat(64);
        const receiptRequestHash = 'c'.repeat(64);
        const admissionOwnerContextRef = `job:${workerKey}:run:${admissionId}`;
        const workerOwnerContextRef = `job:${workerKey}:run:${deliveryId}`;
        yield* insert(sql`insert into core.action_invocations(action_invocation_id,tenant_id,legal_entity_id,principal_id,auth_method,auth_context_ref,action_key,idempotency_key,status,request_hash,completed_at) values
          (${originalOwnerInvocation}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${machinePrincipal}::uuid,'system',${admissionOwnerContextRef},${originalWriteKey},${originalIdempotencyKey},'succeeded',${originalRequestHash},now()),
          (${originalWorkerInvocation}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,${machinePrincipal}::uuid,'system',${workerOwnerContextRef},${originalWriteKey},'native-original-worker-command','succeeded',${originalRequestHash},now()),
          (${originalTenantInvocation}::uuid,${tenantId}::uuid,null,${machinePrincipal}::uuid,'system',${admissionOwnerContextRef},${originalTenantWriteKey},'native-original-tenant-command','succeeded',${originalRequestHash},now())`);
        yield* insert(sql`update core.principals set status='disabled' where principal_id=${originalPrincipal}::uuid`);
        expect(Exit.isFailure(yield* Effect.exit(issue({ ...admission, expectedPrincipalId: ambiguousMachine })))).toBe(
          true,
        );
        yield* insert(
          sql`update core.access_workload_bindings set status='revoked',revoked_at=now() where tenant_id=${tenantId}::uuid and principal_id=${originalPrincipal}::uuid and workload_key=${targetWorkload} and status='active'`,
        );
        const admissionRecovery = {
          _tag: 'RegisteredRecovery' as const,
          declarationKey: recoveryCapability,
          expectedPrincipalId: recoveryPrincipalId,
          operationRequirementKey: admissionRecoveryRequirement,
          originalActionKey: originalWriteKey,
          originalIdempotencyKey,
          originalPrincipalId: machinePrincipal,
          originalRequestHash,
          requestHash: receiptRequestHash,
          source: {
            _tag: 'Admission' as const,
            actionInvocationId: admissionId,
            legalEntityId,
            sourceActionKey: sourceAction,
            tenantId,
          },
        };
        const recovered = yield* issue(admissionRecovery);
        // A recovery call may not name the original write, nor a provider version the receiver does not publish.
        expect(
          yield* refusalOf(
            issue(
              {
                ...admissionRecovery,
                declarationKey: originalWriteCapability,
                operationRequirementKey: forbiddenRecoveryWriteRequirement,
              },
              'party-registry',
              providerKey,
              'subject',
              declaring(sourceApp, [
                {
                  ...recoveryRule,
                  declarationKey: originalWriteCapability,
                  entrypointKey: originalWriteKey,
                  sourceActionKey: sourceAction,
                },
              ]),
            ),
          ),
        ).toBe('registered_workload_unmatched');
        expect(
          yield* refusalOf(
            issue(
              admissionRecovery,
              'party-registry',
              providerKey,
              'subject',
              declaring(sourceApp, [{ ...recoveryRule, schemaVersion: '2', sourceActionKey: sourceAction }]),
            ),
          ),
        ).toBe('registered_workload_unmatched');
        expect(recovered.machineContext?.principalId).toBe(recoveryPrincipalId);
        const recoveredPrincipal = yield* receive(recovered.token);
        const recoveredScope = yield* receiverScopes.resolve({
          audience: 'party-registry',
          correlationId: 'native-recovery',
          legalEntityScope: 'required',
          principal: recoveredPrincipal,
        });
        const decideRecovery = (receiptScope: typeof recoveredScope, tenantOnly = false) =>
          gate.decide({
            carrier: {
              accessDeclaration: tenantOnly ? recoveryTenantDeclaration : recoveryDeclaration,
              accessWorkload: recoveryAccessWorkload,
              entrypoint: tenantOnly ? recoveryTenantEntrypoint : recoveryEntrypoint,
              schemaVersion: '1',
            },
            legalEntityScope: tenantOnly ? 'forbidden' : 'required',
            now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            scope: receiptScope,
          });
        expect((yield* decideRecovery(recoveredScope)).outcome).toBe('ALLOWED');
        expect((yield* decide(recoveredScope)).outcome).toBe('DENIED');
        const recoveryPrivacySubject = {
          _tag: 'RegisteredAssertion' as const,
          declarationKey: privacyCapability,
          expectedPrincipalId: privacyMachine,
          operationRequirementKey: privacyRecoveryRequirement,
          recoveryRequestHash: 'e'.repeat(64),
          sourceAssertion: recovered.token,
        };
        const recoveryPrivacy = yield* issue(recoveryPrivacySubject, 'privacy', partyProviderKey);
        const recoveryPrivacyWith = (catalog: typeof installed) =>
          refusalOf(issue(recoveryPrivacySubject, 'privacy', partyProviderKey, 'subject', catalog));
        expect(yield* recoveryPrivacyWith(declaring('party-registry', [privacyRecoveryRule]))).toBe('issued');
        expect(() => decodeCheckedCalls([privacyRecoveryRule, { ...privacyRecoveryRule }])).toThrow();
        yield* Effect.forEach(
          [[privacyRecoveryRule, { ...privacyRecoveryRule }], [{ ...privacyRecoveryRule, allowRecoverySource: false }]],
          (calls) =>
            recoveryPrivacyWith(declaring('party-registry', calls, decodeUncheckedCalls)).pipe(
              Effect.map((refusal) => expect(refusal).toBe('registered_workload_unmatched')),
            ),
          { discard: true },
        );
        // A caller cannot choose provenance mode by copying metadata into an otherwise real token.
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                {
                  ...nestedSubject,
                  recoveryRequestHash: 'e'.repeat(64),
                  sourceAssertion: tamperWorkloadClaim(issued.token, recovered.token),
                },
                'privacy',
                partyProviderKey,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                {
                  ...recoveryPrivacySubject,
                  sourceAssertion: tamperWorkloadClaim(recovered.token, issued.token),
                },
                'privacy',
                partyProviderKey,
              ),
            ),
          ),
        ).toBe(true);

        const recoveryPrivacyPrincipal = yield* privacyVerifier
          .verifyAndRedeem(Redacted.make(`Bearer ${recoveryPrivacy.token}`), {
            environment: {
              ONTOS_GATEWAY_ISSUER: issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'native-v4', use: 'sig' }],
              }),
            },
            redemption: nativeRedemption(runtime),
          })
          .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
        const recoveryPrivacyScope = yield* scopeResolver.resolve({
          audience: 'privacy',
          correlationId: 'native-recovery-privacy',
          legalEntityScope: 'required',
          principal: recoveryPrivacyPrincipal,
        });
        expect(
          (yield* nativeMachineGate(runtime).decide({
            carrier: {
              accessDeclaration: privacyDeclaration,
              accessWorkload: privacyAccessWorkload,
              entrypoint: privacyEntrypoint,
              schemaVersion: '1',
            },
            legalEntityScope: 'required',
            now: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            scope: recoveryPrivacyScope,
          })).outcome,
        ).toBe('ALLOWED');
        expect(readVerifiedGatewayRecovery(recoveryPrivacyScope)?.originalActionInvocationId).toBe(
          originalOwnerInvocation,
        );
        expect(readVerifiedGatewayRecovery(recoveryPrivacyScope)?.requestHash).toBe('e'.repeat(64));
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue(
                {
                  _tag: 'RegisteredAssertion',
                  declarationKey: privacyCapability,
                  expectedPrincipalId: privacyMachine,
                  sourceAssertion: recovered.token,
                },
                'privacy',
                partyProviderKey,
              ),
            ),
          ),
        ).toBe(true);

        expect(readVerifiedGatewayRecovery(recoveredScope)).toEqual({
          originalActionInvocationId: originalOwnerInvocation,
          originalActionKey: originalWriteKey,
          originalAuthContextRef: `job:${workerKey}:run:${admissionId}`,
          originalIdempotencyKey,
          originalPrincipalId: machinePrincipal,
          originalRequestHash,
          requestHash: receiptRequestHash,
        });
        yield* insert(
          sql`update core.tenant_module_states set state='read_only' where tenant_id=${tenantId}::uuid and module_key=${sourceModule}`,
        );
        yield* issue(admissionRecovery);
        yield* insert(
          sql`update core.tenant_module_states set state='quarantined' where tenant_id=${tenantId}::uuid and module_key=${sourceModule}`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(admissionRecovery)))).toBe(true);
        yield* insert(
          sql`update core.tenant_module_states set state='inactive' where tenant_id=${tenantId}::uuid and module_key=${sourceModule}`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(admissionRecovery)))).toBe(true);
        yield* insert(
          sql`update core.tenant_module_states set state='active' where tenant_id=${tenantId}::uuid and module_key=${sourceModule}`,
        );
        yield* issue(admissionRecovery);
        // Intrinsic declarations also exist: a supplied bad conditional key still cannot fall back.
        const invalidRecoveries = [
          { ...admissionRecovery, operationRequirementKey: workerRecoveryRequirement },
          { ...admissionRecovery, operationRequirementKey: 'integration.symmy.requirement.unknown-recovery' },
          { ...admissionRecovery, originalIdempotencyKey: 'not-the-original-key' },
          { ...admissionRecovery, originalRequestHash: 'd'.repeat(64) },
          { ...admissionRecovery, originalActionKey: originalTenantWriteKey },
          { ...admissionRecovery, originalPrincipalId: ambiguousMachine },
          { ...admissionRecovery, expectedPrincipalId: machinePrincipal },
          { ...admissionRecovery, source: { ...admissionRecovery.source, legalEntityId: foreignLegalEntityId } },
          {
            ...admissionRecovery,
            source: { ...admissionRecovery.source, actionInvocationId: originalOwnerInvocation },
          },
        ];
        for (const invalid of invalidRecoveries) {
          expect(Exit.isFailure(yield* Effect.exit(issue(invalid)))).toBe(true);
        }
        const tenantRecovery = {
          ...admissionRecovery,
          declarationKey: recoveryTenantCapability,
          operationRequirementKey: admissionTenantRecoveryRequirement,
          originalActionKey: originalTenantWriteKey,
          originalIdempotencyKey: 'native-original-tenant-command',
          source: {
            _tag: 'Admission' as const,
            actionInvocationId: admissionId,
            sourceActionKey: sourceAction,
            tenantId,
          },
        };
        const recoveredTenant = yield* issue(tenantRecovery, 'party-registry', providerKey, 'tenant');
        const recoveredTenantPrincipal = yield* receive(recoveredTenant.token);
        const recoveredTenantScope = yield* receiverScopes.resolve({
          audience: 'party-registry',
          correlationId: 'native-tenant-recovery',
          legalEntityScope: 'forbidden',
          principal: recoveredTenantPrincipal,
        });
        expect(recoveredTenantScope.legalEntityId).toBeUndefined();
        expect((yield* decideRecovery(recoveredTenantScope, true)).outcome).toBe('ALLOWED');
        expect(
          Exit.isFailure(
            yield* Effect.exit(issue({ ...tenantRecovery, source: { ...tenantRecovery.source, legalEntityId } })),
          ),
        ).toBe(true);
        yield* insert(
          sql`update core.outbox_deliveries set status='processing',claimed_by='native-claim',claim_expires_at=now()+interval '60 seconds' where outbox_delivery_id=${deliveryId}::uuid`,
        );
        const workerRecovery = {
          ...admissionRecovery,
          operationRequirementKey: workerRecoveryRequirement,
          originalIdempotencyKey: 'native-original-worker-command',
          source: { _tag: 'Worker' as const, claimId: 'native-claim', deliveryId, legalEntityId, tenantId, workerKey },
        };
        expect(
          Exit.isFailure(
            yield* Effect.exit(issue({ ...workerRecovery, operationRequirementKey: admissionRecoveryRequirement })),
          ),
        ).toBe(true);
        const recoveredWorker = yield* issue(workerRecovery);
        const recoveredWorkerPrincipal = yield* receive(recoveredWorker.token);
        const recoveredWorkerScope = yield* receiverScopes.resolve({
          audience: 'party-registry',
          correlationId: 'native-worker-recovery',
          legalEntityScope: 'required',
          principal: recoveredWorkerPrincipal,
        });
        expect((yield* decideRecovery(recoveredWorkerScope)).outcome).toBe('ALLOWED');
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              issue({ ...workerRecovery, source: { ...workerRecovery.source, claimId: 'not-the-claim' } }),
            ),
          ),
        ).toBe(true);
        yield* insert(
          sql`update core.outbox_deliveries set claimed_by='new-recovery-claim' where outbox_delivery_id=${deliveryId}::uuid`,
        );
        expect((yield* decideRecovery(recoveredWorkerScope)).outcome).toBe('DENIED');
        yield* insert(
          sql`update core.outbox_deliveries set status='done',claimed_by=null,claim_expires_at=null where outbox_delivery_id=${deliveryId}::uuid`,
        );
        const historicalRecovery = {
          ...workerRecovery,
          source: { _tag: 'HistoricalDelivery' as const, deliveryId, legalEntityId, tenantId, workerKey },
        };
        const recoveredHistorical = yield* issue(historicalRecovery);
        // Historical delivery recovery needs its own explicit call whose original job is the worker's.
        yield* Effect.forEach(
          [
            { ...recoveryRule, workerKey },
            {
              ...recoveryRule,
              allowHistoricalDeliveryRecovery: true,
              recoveryOf: { actionKey: originalWriteKey, jobKey: `${workerKey}.other` },
              workerKey,
            },
          ],
          (invalidCall) =>
            refusalOf(
              issue(historicalRecovery, 'party-registry', providerKey, 'subject', declaring(sourceApp, [invalidCall])),
            ).pipe(Effect.map((refusal) => expect(refusal).toBe('registered_workload_unmatched'))),
          { discard: true },
        );
        expect(recoveredHistorical.machineContext?.principalId).toBe(recoveryPrincipalId);
        const historicalPrincipal = yield* receive(recoveredHistorical.token);
        const historicalScope = yield* receiverScopes.resolve({
          audience: 'party-registry',
          correlationId: 'native-historical-delivery-recovery',
          legalEntityScope: 'required',
          principal: historicalPrincipal,
        });
        const historicalWorkload = readVerifiedGatewayWorkload(historicalScope);
        expect(historicalWorkload?.sourceMode).toBe('historical_delivery');
        expect(historicalWorkload?.claimId).toBeUndefined();
        expect(historicalWorkload?.workerKey).toBe(workerKey);
        expect(historicalWorkload?.workerModuleKey).toBe(sourceModule);
        expect(readVerifiedGatewayRecovery(historicalScope)?.originalActionInvocationId).toBe(originalWorkerInvocation);
        expect((yield* decideRecovery(historicalScope)).outcome).toBe('ALLOWED');
        expect((yield* decide(historicalScope)).outcome).toBe('DENIED');
        yield* Effect.forEach(
          ['pending', 'processing', 'done'] as const,
          Effect.fn('NativeGateway.historicalDeliveryStates')(function* historicalDeliveryState(
            status: 'pending' | 'processing' | 'done',
          ) {
            yield* insert(
              sql`update core.outbox_deliveries set status=${status} where outbox_delivery_id=${deliveryId}::uuid`,
            );
            const assertion = yield* issue(historicalRecovery);
            const principal = yield* receive(assertion.token);
            const historicalStateScope = yield* receiverScopes.resolve({
              audience: 'party-registry',
              correlationId: 'native-historical-read-any-delivery-state',
              legalEntityScope: 'required',
              principal,
            });
            expect(readVerifiedGatewayWorkload(historicalStateScope)?.sourceMode).toBe('historical_delivery');
            expect(readVerifiedGatewayWorkload(historicalStateScope)?.claimId).toBeUndefined();
            expect(readVerifiedGatewayRecovery(historicalStateScope)?.originalActionInvocationId).toBe(
              originalWorkerInvocation,
            );
            expect((yield* decideRecovery(historicalStateScope)).outcome).toBe('ALLOWED');
            expect((yield* decide(historicalStateScope)).outcome).toBe('DENIED');
          }),
          { concurrency: 1, discard: true },
        );
        expect(
          Schema.is(RegisteredGatewayWorkloadSchema)(
            Object.fromEntries(Object.entries(historicalWorkload ?? {}).filter(([key]) => key !== 'recovery')),
          ),
        ).toBe(false);
        expect(Schema.is(RegisteredGatewayWorkloadSchema)({ ...historicalWorkload, claimId: 'not-a-live-claim' })).toBe(
          false,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(workerRecovery)))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(issue(backgroundWrite)))).toBe(true);
        const invalidHistoricalRecoveries = [
          { ...historicalRecovery, operationRequirementKey: admissionRecoveryRequirement },
          { ...historicalRecovery, operationRequirementKey: 'integration.symmy.requirement.unknown-recovery' },
          { ...historicalRecovery, source: { ...historicalRecovery.source, deliveryId: admissionId } },
          { ...historicalRecovery, source: { ...historicalRecovery.source, workerKey: `${workerKey}.other` } },
          { ...historicalRecovery, source: { ...historicalRecovery.source, tenantId: otherTenantId } },
          { ...historicalRecovery, originalIdempotencyKey },
          { ...historicalRecovery, originalRequestHash: 'd'.repeat(64) },
          { ...historicalRecovery, originalActionKey: originalTenantWriteKey },
          { ...historicalRecovery, expectedPrincipalId: machinePrincipal },
        ];
        for (const invalid of invalidHistoricalRecoveries) {
          expect(Exit.isFailure(yield* Effect.exit(issue(invalid)))).toBe(true);
        }
        const wrongWorkerContextRef = `job:${workerKey}.other:run:${deliveryId}`;
        yield* insert(
          sql`update core.action_invocations set auth_context_ref=${wrongWorkerContextRef} where action_invocation_id=${originalWorkerInvocation}::uuid`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(historicalRecovery)))).toBe(true);
        yield* insert(
          sql`update core.action_invocations set auth_context_ref=${workerOwnerContextRef} where action_invocation_id=${originalWorkerInvocation}::uuid`,
        );
        yield* insert(
          sql`update core.outbox_messages set payload_json=${JSON.stringify({ jobId: admissionId })}::jsonb where outbox_message_id=${messageId}::uuid`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(historicalRecovery)))).toBe(true);
        yield* insert(
          sql`update core.outbox_messages set payload_json=${JSON.stringify({ jobId: historicalJobId })}::jsonb where outbox_message_id=${messageId}::uuid`,
        );
        yield* insert(
          sql`update core.domain_events set subject_resource_id=${admissionId} where domain_event_id=${eventId}::uuid`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(historicalRecovery)))).toBe(true);
        yield* insert(
          sql`update core.domain_events set subject_resource_id=${historicalJobId} where domain_event_id=${eventId}::uuid`,
        );
        yield* insert(
          sql`update core.action_invocations set action_key='integration.fixture.other-admission' where action_invocation_id=${admissionId}::uuid`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(historicalRecovery)))).toBe(true);
        yield* insert(
          sql`update core.action_invocations set action_key=${sourceAction} where action_invocation_id=${admissionId}::uuid`,
        );
        yield* issue(historicalRecovery);
        expect(yield* systemPrincipalDisableRefused(recoveryPrincipalId)).toBe(true);
        yield* insert(
          sql`update core.access_workload_bindings set status='revoked',revoked_at=now() where binding_id=${recoveryBindingId}::uuid`,
        );
        expect((yield* decideRecovery(recoveredScope)).outcome).toBe('DENIED');
        expect((yield* decideRecovery(historicalScope)).outcome).toBe('DENIED');
        expect(Exit.isFailure(yield* Effect.exit(issue(admissionRecovery)))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(issue(historicalRecovery)))).toBe(true);
        yield* insert(
          sql`insert into core.access_workload_bindings(binding_id,tenant_id,principal_id,workload_key,incarnation,status) values(${yield* crypto.randomUUIDv4()}::uuid,${tenantId}::uuid,${recoveryPrincipalId}::uuid,${recoveryWorkload},${yield* crypto.randomUUIDv4()}::uuid,'active')`,
        );
        yield* issue(admissionRecovery);
        yield* insert(
          sql`update core.principal_auth_bindings set status='revoked',revoked_at=now() where principal_auth_binding_id=${moduleAuthBinding}::uuid`,
        );
        expect(Exit.isFailure(yield* Effect.exit(issue(admissionRecovery)))).toBe(true);
      }),
    ).pipe(
      Effect.provide(makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT)),
      Effect.provide(NodeServices.layer),
    ),
);
