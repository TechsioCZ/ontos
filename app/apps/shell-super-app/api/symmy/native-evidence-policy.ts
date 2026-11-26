import {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { resolveSymmyOwnerReleaseBase } from './owner-release-transport.ts';
import { Effect, Predicate, Schema } from 'effect';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/symmy-integration/outbox/integration-symmy-job-admitted-v1';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { delegationForbidden, delegationUnavailable } from '../auth/gateway-delegation-errors.ts';
import {
  gatewayPublishedOperationAccess,
  gatewayRegisteredOperationContractAllows,
} from '../auth/gateway-delegation-policy.ts';
import type {
  NativeReadAdmissionInput,
  NativeReadRouteScope,
  NativeReadReceiver,
  VerifiedNativeReadSource,
  NativeRoutePolicy,
} from '../auth/gateway-native-route-policy.ts';
import type { HistoricalAdmissionPolicy, RouteSourceWorkloads } from '../auth/gateway-native-evidence.ts';

const intakeRequirement = 'integration.symmy.requirement.customer-intake-privacy';
const intakeAction = 'integration.symmy.admit-symmy-job';
const privacyRead = 'privacy.core.api.source-processing-eligibility';
const privacyModule = 'privacy.core';
export const symmyIntakeReadWorkload = 'privacy.core.source-processing-check';
const symmyAudience = 'symmy-integration';

const symmyModule = outboxProducerModuleKey;
const admissionWorkload = 'integration.symmy-admit';
const pollWorkload = 'integration.symmy-poll';
type InstalledContract = ShellInstalledCatalog['contracts'][number];

export type Route = typeof SymmyRouteContextResponseSchema.Type;
export type RouteRequest = typeof SymmyRouteContextRequestSchema.Encoded;
const SourcePurposeSchema = Schema.Literals(['admit', 'read']);
export type SourcePurpose = typeof SourcePurposeSchema.Type;
const routeJsonSchema = Schema.fromJsonString(SymmyRouteContextResponseSchema);
const readRoutes: ReadonlySet<RouteRequest['routeKey']> = new Set([
  'adminCustomers',
  'adminProducts',
  'adminRegions',
  'priceLists',
]);

export const validateSymmyRouteRequest = Effect.fn('SymmyEvidencePolicy.validateRouteRequest')(
  function* validate(input: { readonly routeRequest: RouteRequest; readonly sourcePurpose: SourcePurpose }) {
    const sourcePurpose = yield* Schema.decodeUnknownEffect(SourcePurposeSchema)(input.sourcePurpose).pipe(
      Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
    );
    const routeRequest = yield* Schema.decodeUnknownEffect(SymmyRouteContextRequestSchema)(input.routeRequest).pipe(
      Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
    );
    if ((sourcePurpose === 'read') !== readRoutes.has(routeRequest.routeKey)) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
    return { routeRequest, sourcePurpose };
  },
);

export const resolveSymmyOwnerRoute = Effect.fn('SymmyEvidencePolicy.resolveOwnerRoute')(function* resolve(input: {
  readonly assertion: { readonly apiBaseUrl: string; readonly compositionRevision: string; readonly token: string };
  readonly requestCorrelation: string;
  readonly routeRequest: typeof SymmyRouteContextRequestSchema.Type;
}) {
  const { assertion, routeRequest } = input;
  const baseUrl = yield* resolveSymmyOwnerReleaseBase(assertion.apiBaseUrl, symmyAudience).pipe(
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
  );
  return yield* executeSymmyRouteContextWithAuthorization(
    routeRequest,
    `Bearer ${assertion.token}`,
    input.requestCorrelation,
    { baseUrl, compositionRevision: assertion.compositionRevision },
  ).pipe(
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, 'SymmyRouteContextForbiddenProblem') ||
      Predicate.isTagged(cause, 'SymmyRouteContextAuthenticationProblem')
        ? delegationForbidden('symmy_route_not_admitted')(cause)
        : delegationUnavailable('symmy_route_unavailable')(cause),
    ),
  );
});

export const encodeSymmyOwnerRoute = (route: Route) =>
  Schema.encodeEffect(routeJsonSchema)(route).pipe(Effect.mapError(delegationUnavailable('symmy_route_unavailable')));
export const decodeSymmyOwnerRoute = (json: string) =>
  Schema.decodeUnknownEffect(routeJsonSchema)(json).pipe(
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
  );

export const symmyRouteSourceWorkloads = (purpose: 'admit' | 'read'): RouteSourceWorkloads =>
  purpose === 'read' ? { preferred: admissionWorkload, secondary: pollWorkload } : { preferred: admissionWorkload };

const historicalEvidenceSchema = Schema.Struct({
  eventPayload: OutboxPayloadSchema,
  messagePayload: OutboxPayloadSchema,
  subjectResourceId: OutboxPayloadSchema.fields.jobId,
  subjectResourceType: Schema.Literal('integration.symmy.import-job'),
  topic: Schema.Literal(outboxTopic),
});

export const symmyHistoricalAdmission: HistoricalAdmissionPolicy = {
  agrees: (value) =>
    Schema.decodeUnknownEffect(historicalEvidenceSchema, { onExcessProperty: 'error' })(value).pipe(
      Effect.map(
        ({ eventPayload, messagePayload, subjectResourceId }) =>
          eventPayload.jobId === messagePayload.jobId && eventPayload.jobId === subjectResourceId,
      ),
      Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
    ),
  moduleId: symmyModule,
  topic: outboxTopic,
};

const nativeRouteIdentityMatches = (
  source: VerifiedNativeReadSource,
  signedRoute: NativeReadRouteScope,
  native: NativeReadReceiver,
): boolean =>
  source.workload === undefined &&
  source.principal.authMethod === 'system' &&
  source.principal.legalEntityId === undefined &&
  ['adminCustomers', 'customersBatch', 'customerGroupCustomersBatch'].includes(signedRoute.routeKey) &&
  signedRoute.legalEntityId !== undefined &&
  native.enrollmentLegalEntityId === signedRoute.legalEntityId &&
  signedRoute.principalId === source.principal.principalId &&
  signedRoute.tenantId === source.principal.tenantId;

const nativeCallingReleaseMatches = (
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource,
  native: NativeReadReceiver,
  consumer: InstalledContract,
  priorActorContract: InstalledContract | undefined,
): boolean =>
  input.actor.appId === input.binding.sourceAppId &&
  input.actor.buildMarker === input.binding.sourceBuildMarker &&
  input.actor.principalId !== source.principal.principalId &&
  input.actor.principalId !== native.originalPrincipalId &&
  source.sourceAppId === input.binding.sourceAppId &&
  source.providerKeyId === input.binding.providerKeyId &&
  source.sourceBuildMarker === input.binding.sourceBuildMarker &&
  source.compositionRevision === input.binding.compositionRevision &&
  source.compositionRevision === input.installed.composition.revision &&
  consumer.deployment.buildMarker === input.binding.sourceBuildMarker &&
  (source.sourceActor === undefined || priorActorContract?.deployment.buildMarker === source.sourceActor.buildMarker);

const requireOnwardReadEligibility = Effect.fn('GatewayDelegation.requireOnwardReadEligibility')(function* eligibility(
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource,
  signedRoute: NativeReadRouteScope,
  native: NativeReadReceiver,
) {
  const consumer = input.installed.contracts.find(
    (contract) => contract.deployment.appId === input.binding.sourceAppId,
  );
  const destination = input.installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  const requirements =
    consumer?.manifest.requirements?.operations.filter(
      (requirement) => requirement.key === input.operationRequirementKey,
    ) ?? [];
  const [requirement] = requirements;
  const sourceOperations = signedRoute.operations.filter(
    (operation) =>
      operation.entrypointKey === requirement?.entrypointKey &&
      consumer !== undefined &&
      gatewayPublishedOperationAccess(consumer, operation.entrypointKey, operation.schemaVersion) === 'read',
  );
  const [sourceOperation] = sourceOperations;
  // Native route reads carry current binding evidence, never signed V4 recovery/delivery authority.
  const rules = (input.binding.registeredWorkloads ?? []).filter(
    (rule) =>
      requirement !== undefined &&
      destination !== undefined &&
      rule.audience === input.audience &&
      rule.entrypointKey === requirement.provider.entrypointKey &&
      rule.schemaVersion === requirement.provider.schemaVersion &&
      rule.sourceWorkloadKey === native.workloadKey &&
      rule.jobKey === 'integration.symmy.execute-symmy-job' &&
      rule.sourceActionKey === undefined &&
      rule.workerKey === undefined &&
      rule.recoveryOf === undefined &&
      rule.allowRecoverySource !== true &&
      rule.allowHistoricalDeliveryRecovery !== true,
  );
  const [rule] = rules;
  const priorActor = source.sourceActor;
  const priorActorContract =
    priorActor === undefined
      ? undefined
      : input.installed.contracts.find((contract) => contract.deployment.appId === priorActor.appId);
  if (
    consumer === undefined ||
    destination === undefined ||
    requirements.length !== 1 ||
    requirement === undefined ||
    sourceOperations.length !== 1 ||
    sourceOperation === undefined ||
    rules.length !== 1 ||
    rule === undefined ||
    !nativeRouteIdentityMatches(source, signedRoute, native) ||
    !nativeCallingReleaseMatches(input, source, native, consumer, priorActorContract) ||
    requirement.provider.moduleId !== destination.manifest.module.id ||
    gatewayPublishedOperationAccess(destination, rule.entrypointKey, rule.schemaVersion) !== 'read' ||
    !gatewayRegisteredOperationContractAllows(consumer, destination, rule, signedRoute.legalEntityId, {
      requirementKey: input.operationRequirementKey,
      sourceEntrypointKey: sourceOperation.entrypointKey,
      sourceSchemaVersion: sourceOperation.schemaVersion,
    })
  ) {
    return yield* delegationForbidden('conditional_requirement_refused')();
  }
  return { consumer, destination, rule };
});

const intakeCallingReleaseMatches = (input: NativeReadAdmissionInput, source: VerifiedNativeReadSource): boolean =>
  input.actor.appId === symmyAudience &&
  input.actor.appId === input.binding.sourceAppId &&
  input.actor.buildMarker === input.binding.sourceBuildMarker &&
  source.sourceAppId === input.binding.sourceAppId &&
  source.providerKeyId === input.binding.providerKeyId &&
  source.sourceBuildMarker === input.binding.sourceBuildMarker &&
  source.compositionRevision === input.binding.compositionRevision &&
  source.compositionRevision === input.installed.composition.revision;

type OperationRequirement = NonNullable<InstalledContract['manifest']['requirements']>['operations'][number];
const intakeDestinationContractAllows = (
  input: NativeReadAdmissionInput,
  consumer: InstalledContract | undefined,
  destination: InstalledContract | undefined,
  requirements: readonly OperationRequirement[],
): boolean => {
  const [requirement] = requirements;
  return (
    consumer?.deployment.buildMarker === input.binding.sourceBuildMarker &&
    consumer.manifest.module.id === symmyModule &&
    destination?.manifest.module.id === privacyModule &&
    input.audience === 'privacy' &&
    input.operationRequirementKey === intakeRequirement &&
    requirements.length === 1 &&
    requirement !== undefined &&
    requirement.entrypointKey === intakeAction &&
    requirement.provider.moduleId === privacyModule &&
    requirement.provider.entrypointKey === privacyRead &&
    requirement.provider.schemaVersion === '1' &&
    gatewayPublishedOperationAccess(consumer, intakeAction, '1') === 'write' &&
    gatewayPublishedOperationAccess(destination, privacyRead, '1') === 'read'
  );
};

const requireIntakeReadEligibility = Effect.fn('GatewayDelegation.requireIntakeReadEligibility')(function* eligibility(
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource | undefined,
  signedRoute: NativeReadRouteScope | undefined,
) {
  const consumer = input.installed.contracts.find((contract) => contract.deployment.appId === symmyAudience);
  const destination = input.installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  const requirements =
    consumer?.manifest.requirements?.operations.filter(
      (requirement) => requirement.key === input.operationRequirementKey,
    ) ?? [];
  if (
    source === undefined ||
    signedRoute === undefined ||
    source.workload !== undefined ||
    signedRoute.nativeReadReceiver !== undefined ||
    (signedRoute.routeKey !== 'customersBatch' && signedRoute.routeKey !== 'customerGroupCustomersBatch') ||
    source.principal.authMethod !== 'api_key' ||
    source.principal.authenticationNamespaceId === undefined ||
    source.principal.legalEntityId === undefined ||
    signedRoute.legalEntityId !== source.principal.legalEntityId ||
    signedRoute.principalId !== source.principal.principalId ||
    signedRoute.tenantId !== source.principal.tenantId ||
    !signedRoute.operations.some(
      (operation) => operation.entrypointKey === intakeAction && operation.schemaVersion === '1',
    ) ||
    !intakeCallingReleaseMatches(input, source) ||
    !intakeDestinationContractAllows(input, consumer, destination, requirements)
  ) {
    return yield* delegationForbidden('conditional_requirement_refused')();
  }
  const routeRequest: typeof SymmyRouteContextRequestSchema.Encoded = {
    routeKey: signedRoute.routeKey,
  };
  return {
    destinationModuleId: privacyModule,
    entrypointKey: privacyRead,
    originalWorkloadKey: admissionWorkload,
    routeRequest,
    schemaVersion: '1',
    signedRoute,
    source,
    sourceModuleId: symmyModule,
    workloadKey: symmyIntakeReadWorkload,
  };
});

export const symmyNativeRoutePolicy: NativeRoutePolicy = {
  admitIntake: requireIntakeReadEligibility,
  admitOnward: requireOnwardReadEligibility,
  authContextJobKey: 'integration.symmy.route-read',
};
