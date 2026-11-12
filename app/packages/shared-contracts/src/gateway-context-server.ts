import { isVerifiedOutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import {
  readModuleOperationRequirement,
  readWorkerModuleOperationRequirement,
  readWorkerExecutionContext,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  readVerifiedGatewayCompositionRevision,
  VerifiedGatewayPrincipalContextSchema,
  readVerifiedGatewayScopeAssertion,
  readVerifiedGatewayWorkload,
  readVerifiedGatewayPrivacyDispatch,
  readVerifiedGatewayOrganizationGovernanceRead,
  readVerifiedGatewayOrganizationProcessingRead,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { Crypto } from 'effect';
import { Config, Effect, Match, Redacted, Schema } from 'effect';

import {
  GatewayCapabilityKeySchema,
  GatewaySourceActionKeySchema,
  GatewayRecoveryIntentFields,
  GatewayPrivacyDispatchOperationSchema,
  organizationGovernanceReadOperationContract,
  privacyDispatchOperationContract,
} from './gateway-context.ts';
import { issueDelegatedGatewayContext } from './gateway-context-api-key.ts';
import type { GatewayContextResponse, GatewayDelegatedContextRequest } from './gateway-context.ts';

export class GatewayDelegationSourceError extends Schema.TaggedError<GatewayDelegationSourceError>()(
  'GatewayDelegationSourceError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}

const VerifiedScopeSchema = VerifiedGatewayPrincipalContextSchema;
const uuidString = Schema.String.check(Schema.isUUID());
const revisionString = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));

/**
 * Whom the call is done for. `Assertion` takes the receiving module's verified scope; `Originator`
 * names the action invocation of asynchronous work, the release that work was admitted under and, for work
 * started in the tenant context, the one company it belongs to.
 */
const RecoverySourceSchema = Schema.Union([
  Schema.TaggedStruct('HistoricalDelivery', {
    compositionRevision: revisionString,
    deliveryId: uuidString.pipe(Schema.brand('GatewayDeliveryId'), Schema.decodeTo(Schema.String)),
    legalEntityId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.legalEntityId),
    tenantId: TrustedPrincipalContextSchema.fields.tenantId,
    workerKey: Schema.NonEmptyString.pipe(Schema.brand('GatewayWorkerKey'), Schema.decodeTo(Schema.String)),
  }),
  Schema.TaggedStruct('Worker', {
    context: Schema.declare<OutboxWorkerHandlerContext>(isVerifiedOutboxWorkerHandlerContext),
    legalEntityId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.legalEntityId),
  }),
  Schema.TaggedStruct('Admission', {
    actionInvocationId: uuidString.pipe(Schema.brand('ActionInvocationId'), Schema.decodeTo(Schema.String)),
    compositionRevision: revisionString,
    legalEntityId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.legalEntityId),
    sourceActionKey: GatewaySourceActionKeySchema,
    tenantId: TrustedPrincipalContextSchema.fields.tenantId,
  }),
]);
const PrivacyDispatchSourceSchema = Schema.Union([
  Schema.TaggedStruct('Worker', {
    context: Schema.declare<OutboxWorkerHandlerContext>(isVerifiedOutboxWorkerHandlerContext),
  }),
  Schema.TaggedStruct('Dispatch', {
    compositionRevision: revisionString,
    dispatchInvocationId: uuidString.pipe(Schema.brand('ActionInvocationId')),
    legalEntityId: uuidString.pipe(Schema.brand('LegalEntityId')),
    tenantId: TrustedPrincipalContextSchema.fields.tenantId,
  }),
  Schema.TaggedStruct('Assertion', { scope: VerifiedScopeSchema }),
]);
export const GatewayDelegationSubjectSchema = Schema.Union([
  Schema.TaggedStruct('OrganizationGovernanceRead', { requestHash: revisionString, scope: VerifiedScopeSchema }),
  Schema.TaggedStruct('PrivacyDispatch', {
    operation: GatewayPrivacyDispatchOperationSchema,
    operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
    source: PrivacyDispatchSourceSchema,
  }),
  Schema.TaggedStruct('RegisteredRecovery', { ...GatewayRecoveryIntentFields, source: RecoverySourceSchema }),
  Schema.TaggedStruct('RegisteredAssertion', {
    declarationKey: GatewayCapabilityKeySchema,
    expectedPrincipalId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.principalId),
    operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
    processingRequestHash: Schema.optionalKey(revisionString),
    recoveryRequestHash: Schema.optionalKey(revisionString),
    scope: VerifiedScopeSchema,
  }).check(
    Schema.makeFilter((subject) =>
      subject.processingRequestHash === undefined || subject.recoveryRequestHash === undefined
        ? undefined
        : 'Processing and recovery request restrictions cannot be combined',
    ),
  ),
  Schema.TaggedStruct('RegisteredAdmission', {
    actionInvocationId: uuidString.pipe(Schema.brand('ActionInvocationId'), Schema.decodeTo(Schema.String)),
    compositionRevision: revisionString,
    declarationKey: GatewayCapabilityKeySchema,
    expectedAuthContextRef: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(500))),
    expectedPrincipalId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.principalId),
    legalEntityId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.legalEntityId),
    operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
    sourceActionKey: GatewaySourceActionKeySchema,
    tenantId: TrustedPrincipalContextSchema.fields.tenantId,
  }),
  Schema.TaggedStruct('Assertion', { scope: VerifiedScopeSchema }),
  Schema.TaggedStruct('RegisteredWorkload', {
    context: Schema.declare<OutboxWorkerHandlerContext>(isVerifiedOutboxWorkerHandlerContext),
    declarationKey: GatewayCapabilityKeySchema,
    expectedPrincipalId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.principalId),
    legalEntityId: Schema.optionalKey(TrustedPrincipalContextSchema.fields.legalEntityId),
    operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
  }),
  Schema.TaggedStruct('Originator', {
    actionInvocationId: uuidString.pipe(Schema.brand('ActionInvocationId')),
    compositionRevision: revisionString,
    legalEntityId: Schema.optionalKey(uuidString.pipe(Schema.brand('LegalEntityId'))),
    tenantId: uuidString.pipe(Schema.brand('TenantId')),
  }),
]);
export type GatewayDelegationSubject = typeof GatewayDelegationSubjectSchema.Encoded;
type RegisteredAssertionDelegationSubject = Extract<GatewayDelegationSubject, { readonly _tag: 'RegisteredAssertion' }>;
type RegisteredWorkloadDelegationSubject = Extract<GatewayDelegationSubject, { readonly _tag: 'RegisteredWorkload' }>;
type RegisteredRecoveryDelegationSubject = Extract<GatewayDelegationSubject, { readonly _tag: 'RegisteredRecovery' }>;
type PrivacyDispatchDelegationSubject = Extract<GatewayDelegationSubject, { readonly _tag: 'PrivacyDispatch' }>;
type OrganizationGovernanceReadDelegationSubject = Extract<
  GatewayDelegationSubject,
  { readonly _tag: 'OrganizationGovernanceRead' }
>;

const checkConditionalWorkerRequirement = Effect.fn('GatewayDelegation.checkConditionalWorkerRequirement')(
  function* checkConditionalWorkerRequirement(
    requirementKey: string,
    context: OutboxWorkerHandlerContext,
    audience: string,
  ) {
    const fact = yield* readWorkerModuleOperationRequirement(requirementKey, context).pipe(
      Effect.mapError(
        (cause) =>
          new GatewayDelegationSourceError({
            cause,
            reason: 'Conditional worker delegation requires its exact active operation lease',
          }),
      ),
    );
    if (
      fact.kind !== 'worker' ||
      fact.requirementKey !== requirementKey ||
      fact.providerAppId !== audience ||
      fact.workerKey !== context.workerKey ||
      fact.compositionRevision !== context.compositionRevision ||
      fact.tenantId !== context.tenantId
    ) {
      return yield* new GatewayDelegationSourceError({
        reason: 'Conditional delegation does not match the verified worker operation',
      });
    }
    return yield* Effect.void;
  },
);

export interface GatewayDelegationRequest {
  readonly audience: string;
  readonly legalEntityScope: 'subject' | 'tenant';
  readonly requestCorrelation: string;
  readonly subject: GatewayDelegationSubject;
}

export interface AcquiredDelegatedGatewayMetadata {
  readonly machineContext?: GatewayContextResponse['machineContext'];
  readonly recovery?: GatewayContextResponse['recovery'];
}

type WireSubject = GatewayDelegatedContextRequest['subject'];
interface WireSubjectRevision {
  readonly compositionRevision: string;
  readonly subject: WireSubject;
}

/** Subject evidence is read from Core-verified provenance only; Shell revalidates it independently. */
const assertionWire = ({
  scope,
}: {
  readonly scope: TrustedPrincipalContext;
}): Effect.Effect<WireSubjectRevision, GatewayDelegationSourceError> => {
  if (readVerifiedGatewayOrganizationProcessingRead(scope) !== undefined) {
    return Effect.fail(
      new GatewayDelegationSourceError({ reason: 'A finite processing Read cannot authorize onward delegation' }),
    );
  }
  const assertion = readVerifiedGatewayScopeAssertion(scope);
  const compositionRevision = readVerifiedGatewayCompositionRevision(scope);
  if (assertion === undefined || compositionRevision === undefined) {
    return Effect.fail(
      new GatewayDelegationSourceError({ reason: 'Verified gateway scope is required to act for the requester' }),
    );
  }
  return Effect.succeed({
    compositionRevision,
    subject: { _tag: 'Assertion', sourceAssertion: Redacted.value(assertion.assertion) },
  });
};

type PrivacyDispatchSource = PrivacyDispatchDelegationSubject['source'];
type PrivacyDispatchWorker = Extract<PrivacyDispatchSource, { readonly _tag: 'Worker' }>;
type PrivacyDispatchAssertion = Extract<PrivacyDispatchSource, { readonly _tag: 'Assertion' }>;

const privacyDispatchWire = Effect.fn('GatewayDelegation.privacyDispatchWire')(function* privacyDispatchWire(
  subject: PrivacyDispatchDelegationSubject,
) {
  const { source, ...intent } = subject;
  return yield* Match.value(source).pipe(
    Match.tag('Worker', ({ context }: PrivacyDispatchWorker) =>
      Effect.succeed({
        compositionRevision: context.compositionRevision,
        subject: {
          ...intent,
          source: {
            _tag: 'Worker' as const,
            claimId: context.claimId,
            deliveryId: context.deliveryId,
            tenantId: context.tenantId,
            workerKey: context.workerKey,
          },
        },
      }),
    ),
    Match.tag('Dispatch', ({ compositionRevision, ...dispatch }) =>
      Effect.succeed({ compositionRevision, subject: { ...intent, source: dispatch } }),
    ),
    Match.tag('Assertion', ({ scope }: PrivacyDispatchAssertion) => {
      const assertion = readVerifiedGatewayScopeAssertion(scope);
      const compositionRevision = readVerifiedGatewayCompositionRevision(scope);
      return assertion === undefined || compositionRevision === undefined
        ? Effect.fail(new GatewayDelegationSourceError({ reason: 'A verified Privacy dispatch assertion is required' }))
        : Effect.succeed({
            compositionRevision,
            subject: {
              ...intent,
              source: { _tag: 'Assertion' as const, sourceAssertion: Redacted.value(assertion.assertion) },
            },
          });
    }),
    Match.exhaustive,
  );
});

const checkPrivacyWorker = Effect.fn('GatewayDelegation.checkPrivacyWorker')(function* checkPrivacyWorker(
  subject: PrivacyDispatchDelegationSubject,
  { context }: PrivacyDispatchWorker,
) {
  yield* readWorkerExecutionContext(context).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayDelegationSourceError({ cause, reason: 'Privacy dispatch requires its exact live worker lease' }),
    ),
  );
  const target = privacyDispatchOperationContract(subject.operation._tag);
  const eligibility = Match.value(subject.operation).pipe(
    Match.tag('PrivacyEligibility', () => true),
    Match.orElse(() => false),
  );
  if (context.workerKey !== 'integration.symmy.symmy-job-privacy-dispatch' || eligibility) {
    return yield* new GatewayDelegationSourceError({
      reason: 'Privacy dispatch does not match the actual worker operation',
    });
  }
  const key = subject.operationRequirementKey;
  if (key === undefined) {
    return target.appId === 'symmy-integration'
      ? yield* Effect.void
      : yield* new GatewayDelegationSourceError({
          reason: 'Privacy worker follow-up requires its exact conditional contract',
        });
  }
  const fact = yield* readWorkerModuleOperationRequirement(key, context).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayDelegationSourceError({ cause, reason: 'Privacy dispatch requires its exact worker contract' }),
    ),
  );
  if (
    fact.providerAppId !== target.appId ||
    fact.providerEntrypointKey !== target.entrypointKey ||
    fact.tenantId !== context.tenantId ||
    fact.compositionRevision !== context.compositionRevision
  ) {
    return yield* new GatewayDelegationSourceError({
      reason: 'Privacy dispatch does not match the actual worker contract',
    });
  }
  return yield* Effect.void;
});

const checkPrivacyContinuation = Effect.fn('GatewayDelegation.checkPrivacyContinuation')(
  function* checkPrivacyContinuation(subject: PrivacyDispatchDelegationSubject, { scope }: PrivacyDispatchAssertion) {
    const metadata = readVerifiedGatewayPrivacyDispatch(scope);
    const key = subject.operationRequirementKey;
    if (metadata === undefined || key === undefined) {
      return yield* new GatewayDelegationSourceError({
        reason: 'A sealed finite Privacy dispatch scope and exact conditional contract are required',
      });
    }
    const source = metadata.target;
    const target = privacyDispatchOperationContract(subject.operation._tag);
    const fact = yield* readModuleOperationRequirement(key, scope).pipe(
      Effect.mapError(
        (cause) =>
          new GatewayDelegationSourceError({
            cause,
            reason: 'Privacy continuation requires its exact active operation lease',
          }),
      ),
    );
    if (
      fact.consumerEntrypointKey !== source.entrypointKey ||
      fact.consumerSchemaVersion !== source.schemaVersion ||
      fact.providerAppId !== target.appId ||
      fact.providerEntrypointKey !== target.entrypointKey ||
      fact.compositionRevision !== readVerifiedGatewayCompositionRevision(scope) ||
      fact.tenantId !== scope.tenantId
    ) {
      return yield* new GatewayDelegationSourceError({
        reason: 'Privacy continuation does not match its actual operation contract',
      });
    }
    return yield* Effect.void;
  },
);

const checkPrivacyDispatchSource = Effect.fn('GatewayDelegation.checkPrivacyDispatchSource')(
  function* checkPrivacyDispatchSource(request: GatewayDelegationRequest, subject: PrivacyDispatchDelegationSubject) {
    const target = privacyDispatchOperationContract(subject.operation._tag);
    if (request.audience !== target.appId || request.legalEntityScope !== 'subject') {
      return yield* new GatewayDelegationSourceError({
        reason: 'Finite Privacy dispatch requires its exact operation and governance scope',
      });
    }
    return yield* Match.value(subject.source).pipe(
      Match.tag('Worker', (worker: PrivacyDispatchWorker) => checkPrivacyWorker(subject, worker)),
      Match.tag('Assertion', (assertion: PrivacyDispatchAssertion) => checkPrivacyContinuation(subject, assertion)),
      Match.tag('Dispatch', () =>
        Match.value(subject.operation).pipe(
          Match.tag('SymmyReceipt', () =>
            subject.operationRequirementKey === 'privacy.core.requirement.symmy-owner-execution-outcome'
              ? Effect.void
              : Effect.fail(
                  new GatewayDelegationSourceError({
                    reason: 'Durable Privacy dispatch requires its exact receipt contract',
                  }),
                ),
          ),
          Match.orElse(() =>
            Effect.fail(
              new GatewayDelegationSourceError({
                reason: 'Durable Privacy dispatch permits only its exact receipt operation',
              }),
            ),
          ),
        ),
      ),
      Match.exhaustive,
    );
  },
);

const subjectWireOf = (
  subject: GatewayDelegationSubject,
): Effect.Effect<WireSubjectRevision, GatewayDelegationSourceError> =>
  Match.value(subject).pipe(
    Match.tag('OrganizationGovernanceRead', ({ requestHash, scope }: OrganizationGovernanceReadDelegationSubject) => {
      const assertion = readVerifiedGatewayScopeAssertion(scope);
      const compositionRevision = readVerifiedGatewayCompositionRevision(scope);
      if (
        assertion?.audience !== 'privacy' ||
        compositionRevision === undefined ||
        scope.legalEntityId === undefined ||
        scope.authenticationNamespaceId === undefined ||
        (scope.authMethod !== 'session' && scope.authMethod !== 'api_key') ||
        scope.impersonatedByPrincipalId !== undefined ||
        readVerifiedGatewayWorkload(scope) !== undefined ||
        readVerifiedGatewayPrivacyDispatch(scope) !== undefined ||
        readVerifiedGatewayOrganizationGovernanceRead(scope) !== undefined
      ) {
        return Effect.fail(
          new GatewayDelegationSourceError({
            reason: 'Organization governance requires the original verified human Privacy scope',
          }),
        );
      }
      return Effect.succeed({
        compositionRevision,
        subject: {
          _tag: 'OrganizationGovernanceRead' as const,
          requestHash,
          sourceAssertion: Redacted.value(assertion.assertion),
        },
      });
    }),
    Match.tag('PrivacyDispatch', privacyDispatchWire),
    Match.tag('RegisteredRecovery', ({ source, ...intent }) =>
      Match.value(source).pipe(
        Match.tag('HistoricalDelivery', ({ compositionRevision, ...delivery }) =>
          Effect.succeed({ compositionRevision, subject: { ...intent, source: delivery } }),
        ),
        Match.tag('Worker', ({ context, legalEntityId }) => {
          if (!isVerifiedOutboxWorkerHandlerContext(context) || context.legalEntityScope !== 'forbidden') {
            return Effect.fail(
              new GatewayDelegationSourceError({
                reason: 'Recovery requires a current verified tenant-only worker context',
              }),
            );
          }
          const base = {
            _tag: 'Worker' as const,
            claimId: context.claimId,
            deliveryId: context.deliveryId,
            tenantId: context.tenantId,
            workerKey: context.workerKey,
          };
          return Effect.succeed({
            compositionRevision: context.compositionRevision,
            subject: { ...intent, source: legalEntityId === undefined ? base : { ...base, legalEntityId } },
          });
        }),
        Match.tag('Admission', ({ compositionRevision, ...admission }) =>
          Effect.succeed({ compositionRevision, subject: { ...intent, source: admission } }),
        ),
        Match.exhaustive,
      ),
    ),
    Match.tag('Originator', (originator) =>
      Effect.succeed({
        compositionRevision: originator.compositionRevision,
        subject:
          originator.legalEntityId === undefined
            ? { _tag: 'Originator', actionInvocationId: originator.actionInvocationId, tenantId: originator.tenantId }
            : {
                _tag: 'Originator',
                actionInvocationId: originator.actionInvocationId,
                legalEntityId: originator.legalEntityId,
                tenantId: originator.tenantId,
              },
      } satisfies WireSubjectRevision),
    ),
    Match.tag('RegisteredAdmission', ({ compositionRevision, ...admission }) =>
      Effect.succeed({ compositionRevision, subject: admission }),
    ),
    Match.tag(
      'RegisteredWorkload',
      ({ context, declarationKey, expectedPrincipalId, legalEntityId, operationRequirementKey }) => {
        // A company-scoped worker always names its company. Shell admits it only when it equals the company of the
        // delivery's original workload admission, so the worker cannot choose another one.
        if (
          !isVerifiedOutboxWorkerHandlerContext(context) ||
          (context.legalEntityScope === 'required'
            ? legalEntityId === undefined
            : context.legalEntityScope !== 'forbidden')
        ) {
          return Effect.fail(
            new GatewayDelegationSourceError({
              reason: 'A current verified worker delivery in its declared company scope is required',
            }),
          );
        }
        const base = {
          _tag: 'RegisteredWorkload' as const,
          claimId: context.claimId,
          declarationKey,
          deliveryId: context.deliveryId,
          tenantId: context.tenantId,
          workerKey: context.workerKey,
        };
        const pinned = expectedPrincipalId === undefined ? base : { ...base, expectedPrincipalId };
        const conditional = operationRequirementKey === undefined ? pinned : { ...pinned, operationRequirementKey };
        return Effect.succeed({
          compositionRevision: context.compositionRevision,
          subject: legalEntityId === undefined ? conditional : { ...conditional, legalEntityId },
        });
      },
    ),
    Match.tag(
      'RegisteredAssertion',
      ({
        declarationKey,
        expectedPrincipalId,
        operationRequirementKey,
        processingRequestHash,
        recoveryRequestHash,
        scope,
      }) =>
        assertionWire({ scope }).pipe(
          Effect.flatMap((source) =>
            Match.value(source.subject).pipe(
              Match.tag('Assertion', (proof) => {
                const base = {
                  _tag: 'RegisteredAssertion' as const,
                  declarationKey,
                  sourceAssertion: proof.sourceAssertion,
                };
                const conditional = operationRequirementKey === undefined ? base : { ...base, operationRequirementKey };
                const recovered =
                  recoveryRequestHash === undefined ? conditional : { ...conditional, recoveryRequestHash };
                const constrained =
                  processingRequestHash === undefined ? recovered : { ...recovered, processingRequestHash };
                return Effect.succeed({
                  compositionRevision: source.compositionRevision,
                  subject: expectedPrincipalId === undefined ? constrained : { ...constrained, expectedPrincipalId },
                });
              }),
              Match.orElse(() =>
                Effect.fail(new GatewayDelegationSourceError({ reason: 'A verified source assertion is required' })),
              ),
            ),
          ),
        ),
    ),
    Match.tag('Assertion', assertionWire),
    Match.exhaustive,
  );

/** Requests a fresh module-to-module context authenticated by this deployment's own module credential. */
export const acquireDelegatedGatewayContext = Effect.fn('GatewayDelegation.acquire')(function* acquire(
  request: GatewayDelegationRequest,
  crypto: Crypto.Crypto,
) {
  const configuration = yield* Config.all({
    apiKey: Config.Redacted('ONTOS_GATEWAY_MODULE_API_KEY'),
    baseUrl: Config.schema(
      Schema.URLFromString.check(
        Schema.makeFilter((url) =>
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.username === '' &&
          url.password === '' &&
          url.hash === ''
            ? undefined
            : 'Gateway transport requires an HTTP URL without credentials or fragment',
        ),
      ),
      'ONTOS_SHELL_GATEWAY_BASE_URL',
    ),
  }).pipe(
    Effect.mapError(
      (cause) => new GatewayDelegationSourceError({ cause, reason: 'Gateway delegation transport is unavailable' }),
    ),
  );
  yield* Match.value(request.subject).pipe(
    Match.tag('OrganizationGovernanceRead', () =>
      request.audience === organizationGovernanceReadOperationContract().appId && request.legalEntityScope === 'subject'
        ? Effect.void
        : Effect.fail(
            new GatewayDelegationSourceError({
              reason: 'Organization governance permits only its fixed Read and original governance scope',
            }),
          ),
    ),
    Match.tag('PrivacyDispatch', (subject) => checkPrivacyDispatchSource(request, subject)),
    Match.tag(
      'RegisteredWorkload',
      Effect.fn('GatewayDelegation.checkConditionalWorkerLease')(function* conditionalWorkerLease(
        subject: RegisteredWorkloadDelegationSubject,
      ) {
        if (subject.operationRequirementKey === undefined) {
          return yield* Effect.void;
        }
        return yield* checkConditionalWorkerRequirement(
          subject.operationRequirementKey,
          subject.context,
          request.audience,
        );
      }),
    ),
    Match.tag(
      'RegisteredRecovery',
      Effect.fn('GatewayDelegation.checkConditionalRecoverySource')(function* conditionalRecoverySource(
        subject: RegisteredRecoveryDelegationSubject,
      ) {
        const key = subject.operationRequirementKey;
        if (key === undefined) {
          return yield* Effect.void;
        }
        return yield* Match.value(subject.source).pipe(
          Match.tag('Worker', ({ context }) => checkConditionalWorkerRequirement(key, context, request.audience)),
          // Historical and post-commit Admission witnesses are independently bound by Shell's native source checks.
          Match.orElse(() => Effect.void),
        );
      }),
    ),
    Match.tag(
      'RegisteredAssertion',
      Effect.fn('GatewayDelegation.checkConditionalLease')(function* conditionalLease(
        subject: RegisteredAssertionDelegationSubject,
      ) {
        const sourceWorkload = readVerifiedGatewayWorkload(subject.scope);
        if (readVerifiedGatewayOrganizationProcessingRead(subject.scope) !== undefined) {
          return yield* new GatewayDelegationSourceError({
            reason: 'A finite processing Read cannot authorize onward delegation',
          });
        }
        if (
          subject.processingRequestHash !== undefined &&
          (sourceWorkload === undefined ||
            sourceWorkload.recovery !== undefined ||
            subject.recoveryRequestHash !== undefined ||
            request.audience !== 'symmy-integration' ||
            subject.declarationKey !== 'integration.symmy.symmy-source-organization-facts.read' ||
            request.legalEntityScope !== 'subject')
        ) {
          return yield* new GatewayDelegationSourceError({
            reason: 'Processing request authority requires its exact scoped workload Read',
          });
        }
        if (subject.operationRequirementKey === undefined) {
          return yield* Effect.void;
        }
        const fact = yield* readModuleOperationRequirement(subject.operationRequirementKey, subject.scope).pipe(
          Effect.mapError(
            (cause) =>
              new GatewayDelegationSourceError({
                cause,
                reason: 'Conditional delegation requires its exact active operation lease',
              }),
          ),
        );
        const workload = readVerifiedGatewayWorkload(subject.scope);
        if (
          workload === undefined ||
          fact.providerAppId !== request.audience ||
          fact.consumerEntrypointKey !== workload.entrypointKey ||
          fact.consumerSchemaVersion !== workload.schemaVersion ||
          fact.compositionRevision !== readVerifiedGatewayCompositionRevision(subject.scope) ||
          fact.tenantId !== subject.scope.tenantId
        ) {
          return yield* new GatewayDelegationSourceError({
            reason: 'Conditional delegation does not match the verified operation',
          });
        }
        return yield* Effect.void;
      }),
    ),
    Match.orElse(() => Effect.void),
  );
  const source = yield* subjectWireOf(request.subject);
  const exchangeId = yield* crypto
    .randomUUIDv4()
    .pipe(
      Effect.mapError(
        (cause) =>
          new GatewayDelegationSourceError({ cause, reason: 'Gateway delegation attempt identity is unavailable' }),
      ),
    );
  const payload = {
    audience: request.audience,
    compositionRevision: source.compositionRevision,
    exchangeId,
    legalEntityScope: request.legalEntityScope,
    subject: source.subject,
  };
  const response = yield* issueDelegatedGatewayContext(payload, {
    apiKey: configuration.apiKey,
    baseUrl: configuration.baseUrl,
    requestCorrelation: request.requestCorrelation,
  });
  if (response.compositionRevision !== source.compositionRevision) {
    return yield* new GatewayDelegationSourceError({ reason: 'Gateway delegation changed the admitted release' });
  }
  const authorization: `Bearer ${string}` = `Bearer ${response.token}`;
  const destination = {
    apiBaseUrl: new URL(response.apiBaseUrl, configuration.baseUrl).toString(),
    authorization,
    compositionRevision: response.compositionRevision,
    expiresAt: response.expiresAt,
  };
  let metadata: AcquiredDelegatedGatewayMetadata = {};
  if (response.machineContext !== undefined) {
    metadata = { ...metadata, machineContext: response.machineContext };
  }
  if (response.recovery !== undefined) {
    metadata = { ...metadata, recovery: response.recovery };
  }
  return { ...destination, ...metadata };
});

export { GatewayCapabilityKeySchema } from './gateway-context.ts';
