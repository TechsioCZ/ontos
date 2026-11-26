import { GatewayNativeEvidence } from './gateway-native-evidence.ts';

import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { computeCanonicalValueHash } from '@app/core-runtime/actions/canonical-value-hash';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayPrivacyDispatchSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type {
  PrivacyDispatchOperation,
  RegisteredGatewayPrivacyDispatch,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { MeasureExecutionEligibilityRequestSchema } from '@app/privacy/api/measure-execution-eligibility';
import { RecordOwnerExecutionOutcomePayloadSchema } from '@app/privacy/api/record-owner-execution-outcome-action';
import type { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import {
  OwnerExecutionReceiptRequestSchema,
  validatePrivacyMeasureHandoff,
} from '@app/privacy/domain/privacy-measure-handoff';
import {
  OutboxPayloadSchema as PrivacyOutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/privacy/outbox/privacy-measure-dispatched';
import type {
  GatewayPrivacyDispatchSubjectSchema,
  PrivacyDispatchConsumer,
  PrivacyDispatchContinuation,
} from '@app/shared-contracts';
import {
  decodeGatewayContextProtectedHeader,
  decodeSupportedGatewayContextClaims,
  PrivacyDispatchContinuationPayloadSchema,
  privacyDispatchConsumerOfContinuationWorker,
  privacyDispatchConsumerOfOperation,
  privacyDispatchConsumerOfWorker,
  privacyDispatchContinuationOperation,
  privacyDispatchOperationContract,
  privacyDispatchOperationFitsConsumer,
} from '@app/shared-contracts';
import { ExecuteSymmyRetentionPayloadSchema } from '@app/symmy-integration/api/execute-symmy-retention-action';
import { SymmyJobPrivacyExecutionRequestSchema } from '@app/symmy-integration/api/symmy-job-privacy-execution';
import { DateTime, Effect, Match, Option, Predicate, Redacted, Schema } from 'effect';
import { jwtVerify } from 'jose';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import {
  bindingAttestsSource,
  gatewayPublishedOperationAccess,
  resolvePublishedFiniteGatewayTarget,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding } from './gateway-delegation-policy.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { GatewayDelegationVerification } from './gateway-delegation-verification.ts';
import { GatewayOriginatorEvidence } from './gateway-originator-evidence.ts';

type Subject = typeof GatewayPrivacyDispatchSubjectSchema.Type;
type Operation = Subject['operation'];
type Source = Subject['source'];
type Contract = ShellInstalledCatalog['contracts'][number];
type Handoff = typeof PrivacyMeasureHandoffSchema.Type;
const privacyModule = outboxProducerModuleKey;
const privacyApp = 'privacy';
const symmyModule = 'integration.symmy';
const dispatchActionKey = 'privacy.core.dispatch-privacy-measure';
const metadataFields = RegisteredGatewayPrivacyDispatchSchema.fields;
const rowSchema = Schema.Struct({
  claimActive: Schema.Boolean,
  claimId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  deliveryId: metadataFields.deliveryId,
  dispatchInvocationId: metadataFields.dispatchInvocationId,
  domainEventId: metadataFields.domainEventId,
  eventPayload: PrivacyOutboxPayloadSchema,
  governanceLegalEntityId: metadataFields.governanceLegalEntityId,
  measureId: metadataFields.measureId,
  messageId: metadataFields.messageId,
  messagePayload: PrivacyOutboxPayloadSchema,
  principalId: metadataFields.principalId,
  tenantId: metadataFields.tenantId,
});
type Row = typeof rowSchema.Type;
interface Evidence {
  readonly principal: TrustedPrincipalContext;
  readonly privacyDispatch: RegisteredGatewayPrivacyDispatch;
  readonly sourceAccess: 'background' | 'read' | 'write';
  readonly sourceKey: string;
}
const mintKey = Object.freeze({ kind: 'privacy_dispatch_evidence' });
class AdmittedPrivacyDispatchValue {
  readonly #evidence: Evidence | undefined;
  constructor(key: typeof mintKey, evidence: Evidence) {
    this.#evidence = key === mintKey ? Object.freeze(evidence) : undefined;
    Object.freeze(this);
  }
  static read(value: AdmittedPrivacyDispatchValue): Evidence | undefined {
    return #evidence in value ? value.#evidence : undefined;
  }
}
export type AdmittedPrivacyDispatch = AdmittedPrivacyDispatchValue;
const witnessSchema = Schema.instanceOf(AdmittedPrivacyDispatchValue);
/** Only this module's private mint key can produce evidence accepted by the private signer. */
export const readAdmittedPrivacyDispatch = (witness: AdmittedPrivacyDispatch): Evidence | undefined =>
  Schema.is(witnessSchema)(witness) ? AdmittedPrivacyDispatchValue.read(witness) : undefined;

/** Symmy executes only a DELETE or ANONYMIZE of exactly one of its own job intents. */
const isSymmyExecutableHandoff = (handoff: Handoff): boolean => {
  const [resource] = handoff.resourceRefs;
  const [content] = handoff.contentScopeRefs;
  const match = /^integration\.symmy\.(?:job|sync-admission):(?<id>[a-fA-F\d-]+)$/u.exec(resource ?? '');
  return (
    (handoff.kind === 'DELETE' || handoff.kind === 'ANONYMIZE') &&
    handoff.dispositionDecision === handoff.kind &&
    handoff.resourceRefs.length === 1 &&
    handoff.contentScopeRefs.length === 1 &&
    Schema.is(Schema.String.check(Schema.isUUID()))(match?.groups?.['id']) &&
    content === `${resource}#integration.symmy.job-intent`
  );
};
/**
 * What every consumer shares: a valid handoff of the trusted tenant, addressed to this consumer and identical to the
 * immutable dispatched event. A consumer's own resource vocabulary is checked by the consumer's own Read, not here, except
 * for Symmy, whose executing worker acts on the shape this graph attests.
 */
export const isSupportedHandoff = (
  consumer: PrivacyDispatchConsumer,
  handoff: Handoff,
  event: { readonly handoff: Handoff; readonly measureId: string; readonly tenantId: string },
): boolean =>
  validatePrivacyMeasureHandoff(handoff).length === 0 &&
  handoff.tenantId === event.tenantId &&
  handoff.owningCapability === consumer.moduleKey &&
  (consumer.moduleKey !== symmyModule || isSymmyExecutableHandoff(handoff)) &&
  handoff.measureId === event.measureId &&
  computeCanonicalValueHash(handoff) === computeCanonicalValueHash(event.handoff);
const loadRow = Effect.fn('PrivacyDispatchEvidence.loadNative')(function* load(input: {
  readonly consumer: PrivacyDispatchConsumer;
  readonly deliveryId?: string;
  readonly dispatchInvocationId?: string;
  readonly tenantId: string;
}) {
  return yield* (yield* GatewayNativeEvidence).loadDispatchRow(
    input,
    {
      actionKey: dispatchActionKey,
      consumerModuleId: input.consumer.moduleKey,
      producerModuleId: privacyModule,
      resourceType: 'privacy.core.privacy-measure',
      topic: outboxTopic,
      workerKey: input.consumer.workerKey,
    },
    rowSchema,
    (row) =>
      isSupportedHandoff(input.consumer, row.messagePayload.handoff, { ...row, handoff: row.eventPayload.handoff }),
  );
});
const continuationRowSchema = Schema.Struct({
  claimActive: Schema.Boolean,
  claimId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  deliveryId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyDispatchContinuationDeliveryId')),
  payload: PrivacyDispatchContinuationPayloadSchema,
});
/**
 * The consumer's own continuation delivery: the consumer's message of its own Action, which a human ran and which
 * succeeded, delivered to the consumer's own continuation worker in the trusted Tenant. Exactly one row or nothing.
 */
const loadContinuationRow = Effect.fn('PrivacyDispatchEvidence.loadContinuation')(function* loadContinuation(input: {
  readonly consumer: PrivacyDispatchConsumer;
  readonly continuation: PrivacyDispatchContinuation;
  readonly deliveryId: string;
  readonly tenantId: string;
}) {
  return yield* (yield* GatewayNativeEvidence).loadContinuationRow(input, continuationRowSchema);
});
/** What a worker's deployed contract must say: its app, its module, the Privacy originator and its own subscription. */
interface WorkerCatalogFacts {
  readonly appId: string;
  readonly moduleId: string;
  readonly originatorActions: readonly string[] | undefined;
  readonly subscriptions: readonly {
    readonly consumerModuleKey: string;
    readonly entrypointKey: string;
    readonly producerModuleKey: string;
    readonly topic: string;
    readonly workerKey: string;
  }[];
}
export const workerCatalogHolds = (facts: WorkerCatalogFacts, consumer: PrivacyDispatchConsumer): boolean =>
  facts.appId === consumer.appId &&
  facts.moduleId === consumer.moduleKey &&
  facts.originatorActions?.includes(dispatchActionKey) === true &&
  facts.subscriptions.some(
    (subscription) =>
      subscription.workerKey === consumer.workerKey &&
      subscription.consumerModuleKey === consumer.moduleKey &&
      subscription.producerModuleKey === privacyModule &&
      subscription.topic === outboxTopic &&
      subscription.entrypointKey === consumer.workerKey,
  );
const assertWorkerCatalog = (contract: Contract, consumer: PrivacyDispatchConsumer): boolean =>
  workerCatalogHolds(
    {
      appId: contract.deployment.appId,
      moduleId: contract.manifest.module.id,
      originatorActions: contract.manifest.originatorActions,
      subscriptions: contract.runtime.outboxSubscriptions.map((subscription) => ({
        consumerModuleKey: subscription.consumerModuleKey,
        entrypointKey: subscription.entrypoint.entrypointKey,
        producerModuleKey: subscription.producerModuleKey,
        topic: subscription.topic,
        workerKey: subscription.workerKey,
      })),
    },
    consumer,
  );
/** What a continuation source's deployed contract must say: the consumer itself, its own Action and its own worker. */
interface ContinuationCatalogFacts {
  readonly actions: readonly {
    readonly access: string;
    readonly actionKey: string;
    readonly protectedAction: boolean;
  }[];
  readonly appId: string;
  readonly moduleId: string;
  readonly subscriptions: WorkerCatalogFacts['subscriptions'];
}
export const continuationCatalogHolds = (
  facts: ContinuationCatalogFacts,
  consumer: PrivacyDispatchConsumer,
  continuation: PrivacyDispatchContinuation,
): boolean =>
  facts.appId === consumer.appId &&
  facts.moduleId === consumer.moduleKey &&
  facts.actions.filter(
    (action) => action.actionKey === continuation.actionKey && action.access === 'write' && action.protectedAction,
  ).length === 1 &&
  facts.subscriptions.filter(
    (subscription) =>
      subscription.workerKey === continuation.workerKey &&
      subscription.consumerModuleKey === consumer.moduleKey &&
      subscription.producerModuleKey === consumer.moduleKey &&
      subscription.topic === continuation.topic &&
      subscription.entrypointKey === continuation.workerKey,
  ).length === 1;
const assertContinuationCatalog = (
  contract: Contract,
  consumer: PrivacyDispatchConsumer,
  continuation: PrivacyDispatchContinuation,
): boolean =>
  continuationCatalogHolds(
    {
      actions: contract.manifest.publicSurface.actions.map((action) => ({
        access: action.entrypoint.access,
        actionKey: action.actionKey,
        protectedAction: action.accessDeclaration !== undefined && action.accessWorkload === undefined,
      })),
      appId: contract.deployment.appId,
      moduleId: contract.manifest.module.id,
      subscriptions: contract.runtime.outboxSubscriptions.map((subscription) => ({
        consumerModuleKey: subscription.consumerModuleKey,
        entrypointKey: subscription.entrypoint.entrypointKey,
        producerModuleKey: subscription.producerModuleKey,
        topic: subscription.topic,
        workerKey: subscription.workerKey,
      })),
    },
    consumer,
    continuation,
  );
/** What the conditional-call check reads of the two deployed contracts. */
interface ConditionalCallFacts {
  readonly declarations: readonly {
    readonly entrypointKey: string;
    readonly key: string;
    readonly provider: { readonly entrypointKey: string; readonly moduleId: string; readonly schemaVersion: string };
  }[];
  readonly moduleId: string;
}
export const conditionalCallAllows = (
  source: ConditionalCallFacts,
  consumerKey: string,
  destinationModuleId: string,
  target: ReturnType<typeof privacyDispatchOperationContract>,
  key: string | undefined,
): boolean => {
  if (source.moduleId === destinationModuleId) {
    return key === undefined;
  }
  const declarations = source.declarations.filter((requirement) => requirement.key === key);
  const [declaration] = declarations;
  return (
    declarations.length === 1 &&
    declaration !== undefined &&
    declaration.entrypointKey === consumerKey &&
    declaration.provider.moduleId === target.moduleId &&
    declaration.provider.entrypointKey === target.entrypointKey &&
    declaration.provider.schemaVersion === target.schemaVersion
  );
};
const conditionalAllows = (
  source: Contract,
  consumerKey: string,
  destination: Contract,
  target: ReturnType<typeof privacyDispatchOperationContract>,
  key: string | undefined,
): boolean =>
  conditionalCallAllows(
    { declarations: source.manifest.requirements?.operations ?? [], moduleId: source.manifest.module.id },
    consumerKey,
    destination.manifest.module.id,
    target,
    key,
  );
export const requestHash = Effect.fn('PrivacyDispatchEvidence.requestHash')(function* hash(
  operation: Operation,
  handoff: Handoff,
) {
  return yield* Match.value(operation).pipe(
    Match.tag('SymmyRetention', () =>
      Schema.decodeUnknownEffect(ExecuteSymmyRetentionPayloadSchema)({ handoff }).pipe(
        Effect.flatMap(Schema.encodeEffect(ExecuteSymmyRetentionPayloadSchema)),
        Effect.map(computeCanonicalValueHash),
      ),
    ),
    Match.tag('SymmyReceipt', (receipt) =>
      Schema.decodeUnknownEffect(SymmyJobPrivacyExecutionRequestSchema)(
        receipt.attempt === undefined
          ? { idempotencyKey: handoff.idempotencyKey }
          : { attempt: receipt.attempt, idempotencyKey: handoff.idempotencyKey },
      ).pipe(Effect.map(computeCanonicalValueHash)),
    ),
    Match.tag('CommunicationsReceipt', (receipt) =>
      Schema.decodeUnknownEffect(OwnerExecutionReceiptRequestSchema)(
        receipt.attempt === undefined ? { handoff } : { attempt: receipt.attempt, handoff },
      ).pipe(Effect.map(computeCanonicalValueHash)),
    ),
    Match.tag('PrivacyEligibility', () =>
      Schema.decodeUnknownEffect(MeasureExecutionEligibilityRequestSchema)({ handoff }).pipe(
        Effect.map(computeCanonicalValueHash),
      ),
    ),
    Match.tag('PrivacyOutcome', (outcome) =>
      Schema.decodeUnknownEffect(RecordOwnerExecutionOutcomePayloadSchema)({
        request: { attempt: outcome.attempt, measureId: handoff.measureId, taskId: handoff.taskId },
      }).pipe(
        Effect.flatMap(Schema.encodeEffect(RecordOwnerExecutionOutcomePayloadSchema)),
        Effect.map(computeCanonicalValueHash),
      ),
    ),
    Match.exhaustive,
    Effect.mapError(delegationForbidden('source_evidence_malformed')),
  );
});
const currentHuman = Effect.fn('PrivacyDispatchEvidence.currentHuman')(function* human(
  row: Row,
  installed: ShellInstalledCatalog,
) {
  const evidence = yield* GatewayOriginatorEvidence;
  const admitted = yield* evidence.loadPrivacyDispatchHuman({
    actionInvocationId: row.dispatchInvocationId,
    tenantId: row.tenantId,
  });
  if (
    admitted.workload ||
    admitted.principal.principalId !== row.principalId ||
    admitted.principal.legalEntityId !== row.governanceLegalEntityId
  ) {
    return yield* delegationForbidden('privacy_dispatch_not_admitted')();
  }
  const privacy = installed.contracts.find((contract) => contract.manifest.module.id === privacyModule);
  const descriptor = privacy?.manifest.publicSurface.actions.find((action) => action.actionKey === dispatchActionKey);
  if (descriptor?.accessDeclaration === undefined || descriptor.legalEntityScope !== 'required') {
    return yield* delegationForbidden('finite_target_mismatch')();
  }
  const scope = yield* (yield* OperationalScopeResolver)
    .resolve({
      audience: privacyApp,
      correlationId: row.dispatchInvocationId,
      legalEntityScope: 'required',
      principal: admitted.principal,
    })
    .pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, 'OperationContextUnavailable')
          ? delegationUnavailable('scope_unavailable')(cause)
          : delegationForbidden('scope_refused')(cause),
      ),
    );
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const decision = yield* (yield* AccessDecisionGate).decide({
    carrier: {
      accessDeclaration: descriptor.accessDeclaration,
      entrypoint: descriptor.entrypoint,
      schemaVersion: descriptor.schemaVersion,
    },
    legalEntityScope: 'required',
    now,
    scope,
  });
  if (decision.outcome === 'UNAVAILABLE') {
    return yield* delegationUnavailable('access_decision_unavailable')();
  }
  if (decision.outcome !== 'ALLOWED') {
    return yield* delegationForbidden('access_decision_refused')();
  }
  return admitted.principal;
});
const verifySource = Effect.fn('PrivacyDispatchEvidence.verifySource')(function* verify(input: {
  readonly assertion: Redacted.Redacted;
  readonly binding: GatewayModuleBinding;
  readonly installed: ShellInstalledCatalog;
}) {
  const configuration = yield* (yield* GatewayDelegationVerification).load;
  const now = yield* DateTime.now;
  const verified = yield* Effect.tryPromise({
    catch: (cause) => delegationForbidden('subject_assertion_unverified')(cause),
    try: jwtVerify.bind(undefined, Redacted.value(input.assertion), configuration.keys, {
      algorithms: ['EdDSA'],
      audience: input.binding.sourceAppId,
      clockTolerance: 0,
      currentDate: DateTime.toDateUtc(now),
      issuer: configuration.issuer,
    }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.fail(delegationUnavailable('subject_verification_timeout')()),
    }),
  );
  yield* decodeGatewayContextProtectedHeader(verified.protectedHeader).pipe(
    Effect.mapError(delegationForbidden('subject_assertion_malformed')),
  );
  const claims = yield* decodeSupportedGatewayContextClaims(verified.payload).pipe(
    Effect.mapError(delegationForbidden('subject_assertion_malformed')),
  );
  if (
    !('privacyDispatch' in claims) ||
    claims.iat > Math.floor(DateTime.toEpochMillis(now) / 1000) ||
    !bindingAttestsSource(input.binding, claims, input.installed.composition.revision)
  ) {
    return yield* delegationForbidden('subject_assertion_not_attested')();
  }
  return claims;
});
export const workerOperationAllows = (
  consumer: PrivacyDispatchConsumer,
  operation: PrivacyDispatchOperation,
): boolean => operation !== 'PrivacyEligibility' && privacyDispatchOperationFitsConsumer(consumer, operation);
export const receiptOperationAllows = (
  consumer: PrivacyDispatchConsumer,
  operation: PrivacyDispatchOperation,
): boolean => operation === consumer.receiptOperation;
/** A receipt follows only the outcome its own consumer reported, for exactly that attempt. */
const outcomeBefore = (
  consumer: PrivacyDispatchConsumer,
  previous: PrivacyDispatchOperation,
  receipt: PrivacyDispatchOperation,
  attempt: number | undefined,
): Option.Option<Operation> =>
  consumer.receiptOperation === receipt && previous === 'PrivacyOutcome' && attempt !== undefined
    ? Option.some<Operation>({ _tag: 'PrivacyOutcome', attempt })
    : Option.none<Operation>();
/** The operation a continuation proves its source to have been: the consumer's own execution, or a reported outcome. */
export const originalOperationFor = (
  consumer: PrivacyDispatchConsumer,
  previous: PrivacyDispatchOperation,
  next: Operation,
): Option.Option<Operation> => {
  if (!privacyDispatchOperationFitsConsumer(consumer, next._tag)) {
    return Option.none<Operation>();
  }
  return Match.value(next).pipe(
    Match.tag('PrivacyEligibility', () =>
      previous === 'SymmyRetention' && consumer.executionOperation === 'SymmyRetention'
        ? Option.some<Operation>({ _tag: 'SymmyRetention' })
        : Option.none<Operation>(),
    ),
    Match.tag('SymmyReceipt', (receipt) => outcomeBefore(consumer, previous, receipt._tag, receipt.attempt)),
    Match.tag('CommunicationsReceipt', (receipt) => outcomeBefore(consumer, previous, receipt._tag, receipt.attempt)),
    Match.orElse(() => Option.none<Operation>()),
  );
};
const sameNativeEvidence = (row: Row, metadata: RegisteredGatewayPrivacyDispatch): boolean =>
  row.tenantId === metadata.tenantId &&
  row.principalId === metadata.principalId &&
  row.governanceLegalEntityId === metadata.governanceLegalEntityId &&
  row.dispatchInvocationId === metadata.dispatchInvocationId &&
  row.domainEventId === metadata.domainEventId &&
  row.messageId === metadata.messageId &&
  row.deliveryId === metadata.deliveryId &&
  row.measureId === metadata.measureId &&
  row.messagePayload.handoff.taskId === metadata.taskId &&
  computeCanonicalValueHash(row.messagePayload.handoff) === metadata.handoffHash;
const workerClaimMatches = (row: Row, claimId: string): boolean =>
  row.claimActive && Option.contains(row.claimId, claimId);

/** The consumer's own worker, subscribed to the Privacy dispatch in the installed catalog, and the consumer it belongs to. */
const consumerCatalogHolds = (installed: ShellInstalledCatalog, consumer: PrivacyDispatchConsumer): boolean => {
  const workerContract = installed.contracts.find((contract) => contract.manifest.module.id === consumer.moduleKey);
  return workerContract !== undefined && assertWorkerCatalog(workerContract, consumer);
};

/**
 * Admits only the fixed Privacy→consumer dispatch graph of one approved consumer from durable native evidence and the
 * original current human. The consumer comes from the proof itself (its worker, or the receipt it reads), never from the
 * caller's wording, and an operation of another consumer is refused.
 */
export const admitPrivacyDispatch = Effect.fn('GatewayDelegation.admitPrivacyDispatch')(function* admit(input: {
  readonly audience: string;
  readonly binding: GatewayModuleBinding;
  readonly installed: ShellInstalledCatalog;
  readonly subject: Subject;
}) {
  const { binding, installed, subject } = input;
  const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
  const approvedTarget = privacyDispatchOperationContract(subject.operation._tag);
  const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  if (
    source === undefined ||
    destination === undefined ||
    input.audience !== approvedTarget.appId ||
    destination.manifest.module.id !== approvedTarget.moduleId ||
    binding.compositionRevision !== installed.composition.revision ||
    binding.sourceBuildMarker !== source.deployment.buildMarker
  ) {
    return yield* delegationForbidden('finite_target_mismatch')();
  }
  const resolved = resolvePublishedFiniteGatewayTarget(destination, approvedTarget);
  if (Option.isNone(resolved)) {
    return yield* delegationForbidden('finite_target_mismatch')();
  }
  const target = resolved.value;
  const admittedSource = yield* Match.value(subject.source).pipe(
    Match.tag(
      'Worker',
      Effect.fn('PrivacyDispatchEvidence.worker')(function* worker(
        proof: Extract<Source, { readonly _tag: 'Worker' }>,
      ) {
        const consumer = privacyDispatchConsumerOfWorker(proof.workerKey);
        if (
          consumer === undefined ||
          !consumerCatalogHolds(installed, consumer) ||
          !assertWorkerCatalog(source, consumer) ||
          !workerOperationAllows(consumer, subject.operation._tag)
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        const row = yield* loadRow({ consumer, deliveryId: proof.deliveryId, tenantId: proof.tenantId });
        if (
          !workerClaimMatches(row, proof.claimId) ||
          !conditionalAllows(source, consumer.workerKey, destination, target, subject.operationRequirementKey)
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        return {
          claimId: proof.claimId,
          row,
          sourceAccess: 'background' as const,
          sourceKey: row.deliveryId,
          sourceMode: 'worker' as const,
          worker: { moduleKey: consumer.moduleKey, workerKey: consumer.workerKey },
        };
      }),
    ),
    Match.tag(
      'Continuation',
      Effect.fn('PrivacyDispatchEvidence.recordedContinuation')(function* recordedContinuation(
        proof: Extract<Source, { readonly _tag: 'Continuation' }>,
      ) {
        const consumer = privacyDispatchConsumerOfContinuationWorker(proof.workerKey);
        const continuation = consumer?.continuation;
        // A continuation reports exactly one outcome: no other operation has an attempt to join it to.
        const attempt = Match.value(subject.operation).pipe(
          Match.tag(privacyDispatchContinuationOperation, (outcome) => Option.some(outcome.attempt)),
          Match.orElse(() => Option.none<number>()),
        );
        if (
          consumer === undefined ||
          continuation === undefined ||
          Option.isNone(attempt) ||
          subject.operationRequirementKey !== continuation.requirementKey ||
          !consumerCatalogHolds(installed, consumer) ||
          !assertContinuationCatalog(source, consumer, continuation)
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        const recorded = yield* loadContinuationRow({
          consumer,
          continuation,
          deliveryId: proof.deliveryId,
          tenantId: proof.tenantId,
        });
        if (
          !recorded.claimActive ||
          !Option.contains(recorded.claimId, proof.claimId) ||
          recorded.payload.attempt !== attempt.value ||
          !conditionalAllows(source, continuation.workerKey, destination, target, subject.operationRequirementKey)
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        // The original dispatch comes from the consumer's own message, which only names it; it is proven natively here.
        const row = yield* loadRow({
          consumer,
          dispatchInvocationId: recorded.payload.dispatchInvocationId,
          tenantId: proof.tenantId,
        });
        if (
          row.measureId !== recorded.payload.measureId ||
          row.messagePayload.handoff.taskId !== recorded.payload.taskId
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        return {
          claimId: proof.claimId,
          continuationDeliveryId: recorded.deliveryId,
          row,
          sourceAccess: 'background' as const,
          sourceKey: recorded.deliveryId,
          sourceMode: 'continuation' as const,
          worker: { moduleKey: consumer.moduleKey, workerKey: continuation.workerKey },
        };
      }),
    ),
    Match.tag(
      'Dispatch',
      Effect.fn('PrivacyDispatchEvidence.dispatch')(function* dispatch(
        proof: Extract<Source, { readonly _tag: 'Dispatch' }>,
      ) {
        const consumer = privacyDispatchConsumerOfOperation(subject.operation._tag);
        if (
          consumer === undefined ||
          !consumerCatalogHolds(installed, consumer) ||
          source.deployment.appId !== privacyApp ||
          source.manifest.module.id !== privacyModule ||
          !receiptOperationAllows(consumer, subject.operation._tag) ||
          subject.operationRequirementKey !== consumer.receiptRequirementKey ||
          !conditionalAllows(
            source,
            privacyDispatchOperationContract('PrivacyOutcome').entrypointKey,
            destination,
            target,
            subject.operationRequirementKey,
          )
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        const row = yield* loadRow({
          consumer,
          dispatchInvocationId: proof.dispatchInvocationId,
          tenantId: proof.tenantId,
        });
        if (row.governanceLegalEntityId !== proof.legalEntityId) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        return { row, sourceAccess: 'read' as const, sourceKey: row.deliveryId, sourceMode: 'dispatch' as const };
      }),
    ),
    Match.tag(
      'Assertion',
      Effect.fn('PrivacyDispatchEvidence.continuation')(function* continuation(
        proof: Extract<Source, { readonly _tag: 'Assertion' }>,
      ) {
        const claims = yield* verifySource({ assertion: proof.sourceAssertion, binding, installed });
        const previous = claims.privacyDispatch;
        const previousContract = privacyDispatchOperationContract(previous.operation, previous.target);
        const consumer = privacyDispatchConsumerOfWorker(previous.workerKey);
        const originalOperation =
          consumer === undefined
            ? Option.none<Operation>()
            : originalOperationFor(consumer, previous.operation, subject.operation);
        if (
          consumer === undefined ||
          !consumerCatalogHolds(installed, consumer) ||
          Option.isNone(originalOperation) ||
          previous.sourceMode !== 'worker' ||
          previous.claimId === undefined ||
          source.manifest.module.id !== previousContract.moduleId ||
          gatewayPublishedOperationAccess(source, previousContract.entrypointKey, previousContract.schemaVersion) !==
            previousContract.access ||
          !conditionalAllows(
            source,
            previousContract.entrypointKey,
            destination,
            target,
            subject.operationRequirementKey,
          )
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        const row = yield* loadRow({ consumer, deliveryId: previous.deliveryId, tenantId: previous.tenantId });
        if (
          !sameNativeEvidence(row, previous) ||
          !workerClaimMatches(row, previous.claimId) ||
          claims.principal.tenantId !== row.tenantId ||
          claims.principal.principalId !== row.principalId ||
          claims.principal.legalEntityId !== row.governanceLegalEntityId
        ) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        if ((yield* requestHash(originalOperation.value, row.messagePayload.handoff)) !== previous.requestHash) {
          return yield* delegationForbidden('privacy_dispatch_not_admitted')();
        }
        return {
          claimId: previous.claimId,
          row,
          sourceAccess: previousContract.access,
          sourceKey: row.deliveryId,
          sourceMode: 'worker' as const,
          worker: { moduleKey: consumer.moduleKey, workerKey: consumer.workerKey },
        };
      }),
    ),
    Match.exhaustive,
  );
  const principal = yield* currentHuman(admittedSource.row, installed);
  const { row } = admittedSource;
  const base = {
    deliveryId: row.deliveryId,
    dispatchInvocationId: row.dispatchInvocationId,
    domainEventId: row.domainEventId,
    governanceLegalEntityId: row.governanceLegalEntityId,
    handoffHash: computeCanonicalValueHash(row.messagePayload.handoff),
    measureId: row.measureId,
    messageId: row.messageId,
    operation: subject.operation._tag,
    principalId: row.principalId,
    requestHash: yield* requestHash(subject.operation, row.messagePayload.handoff),
    sourceMode: admittedSource.sourceMode,
    taskId: row.messagePayload.handoff.taskId,
    tenantId: row.tenantId,
  };
  if (target.schemaVersion !== approvedTarget.schemaVersion) {
    Object.assign(base, { target });
  }
  if ('continuationDeliveryId' in admittedSource) {
    Object.assign(base, { continuationDeliveryId: admittedSource.continuationDeliveryId });
  }
  const metadata =
    'worker' in admittedSource
      ? {
          ...base,
          claimId: admittedSource.claimId,
          workerKey: admittedSource.worker.workerKey,
          workerModuleKey: admittedSource.worker.moduleKey,
        }
      : base;
  const privacyDispatch = yield* Schema.decodeUnknownEffect(RegisteredGatewayPrivacyDispatchSchema)(metadata).pipe(
    Effect.mapError(delegationForbidden('source_evidence_malformed')),
  );
  if (privacyDispatch.target !== undefined) {
    Object.freeze(privacyDispatch.target);
  }
  return new AdmittedPrivacyDispatchValue(mintKey, {
    principal: Object.freeze({ ...principal }),
    privacyDispatch: Object.freeze(privacyDispatch),
    sourceAccess: admittedSource.sourceAccess,
    sourceKey: admittedSource.sourceKey,
  });
});
