import { recoverSqlTransactionError } from '@app/core-runtime';
import { AccessDecisionGate, computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayPrivacyDispatchSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type {
  PrivacyDispatchOperation,
  RegisteredGatewayPrivacyDispatch,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { MeasureExecutionEligibilityRequestSchema } from '@app/privacy/api/measure-execution-eligibility';
import { RecordOwnerExecutionOutcomePayloadSchema } from '@app/privacy/api/record-owner-execution-outcome-action';
import type { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import {
  OwnerExecutionReceiptRequestSchema,
  validatePrivacyMeasureHandoff,
} from '@app/privacy/domain/privacy-measure-handoff';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/privacy/outbox/privacy-measure-dispatched';
import type { GatewayPrivacyDispatchSubjectSchema, PrivacyDispatchConsumer } from '@app/shared-contracts';
import {
  decodeGatewayContextProtectedHeader,
  decodeSupportedGatewayContextClaims,
  privacyDispatchConsumerOfOperation,
  privacyDispatchConsumerOfWorker,
  privacyDispatchOperationContract,
  privacyDispatchOperationFitsConsumer,
} from '@app/shared-contracts';
import { ExecuteSymmyRetentionPayloadSchema } from '@app/symmy-integration/api/execute-symmy-retention-action';
import { SymmyJobPrivacyExecutionRequestSchema } from '@app/symmy-integration/api/symmy-job-privacy-execution';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Predicate, Redacted, Schema } from 'effect';
import { jwtVerify } from 'jose';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import {
  bindingAttestsSource,
  gatewayPublishedOperationAccess,
  resolvePublishedFiniteGatewayTarget,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding } from './gateway-delegation-policy.ts';
import { delegationForbidden, delegationUnavailable, GatewayDelegationError } from './gateway-delegation-errors.ts';
import { GatewayDelegationVerification } from './gateway-delegation-verification.ts';
import { GatewayOriginatorEvidence } from './gateway-originator-evidence.ts';

type Subject = typeof GatewayPrivacyDispatchSubjectSchema.Type;
type Operation = Subject['operation'];
type Source = Subject['source'];
type Contract = ShellInstalledCatalog['contracts'][number];
type Handoff = typeof PrivacyMeasureHandoffSchema.Type;
const metadataFields = RegisteredGatewayPrivacyDispatchSchema.fields;
const privacyModule = outboxProducerModuleKey;
const privacyApp = 'privacy';
const symmyModule = 'integration.symmy';
const communicationsModule = 'communications.core';
const dispatchActionKey = 'privacy.core.dispatch-privacy-measure';
const rowSchema = Schema.Struct({
  claimActive: Schema.Boolean,
  claimId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  deliveryId: metadataFields.deliveryId,
  dispatchInvocationId: metadataFields.dispatchInvocationId,
  domainEventId: metadataFields.domainEventId,
  eventPayload: OutboxPayloadSchema,
  governanceLegalEntityId: metadataFields.governanceLegalEntityId,
  measureId: metadataFields.measureId,
  messageId: metadataFields.messageId,
  messagePayload: OutboxPayloadSchema,
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
/** A Communications measure targets exactly the owner's own opaque content references (`communications.core.<kind>:<id>`). */
const isCommunicationsContentRef = (reference: string): boolean =>
  /^communications\.core\.[a-z][a-z-]*:\S+$/u.test(reference);
const isCommunicationsOwnedHandoff = (handoff: Handoff): boolean =>
  handoff.resourceRefs.every(isCommunicationsContentRef);

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
  (consumer.moduleKey !== communicationsModule || isCommunicationsOwnedHandoff(handoff)) &&
  handoff.measureId === event.measureId &&
  computeCanonicalValueHash(handoff) === computeCanonicalValueHash(event.handoff);
const loadRow = Effect.fn('PrivacyDispatchEvidence.loadNative')(function* load(input: {
  readonly consumer: PrivacyDispatchConsumer;
  readonly deliveryId?: string;
  readonly dispatchInvocationId?: string;
  readonly tenantId: string;
}) {
  const database = yield* CoreDatabase;
  return yield* database.executor
    .transaction(
      Effect.fn('PrivacyDispatchEvidence.nativeTransaction')(function* native(transaction) {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id',${input.tenantId},true),set_config('ontos.legal_entity_id','',true)`,
          'objects',
        );
        const selection =
          input.deliveryId === undefined
            ? sql`i.action_invocation_id=${input.dispatchInvocationId}::uuid`
            : sql`d.outbox_delivery_id=${input.deliveryId}::uuid`;
        const rows = yield* transaction.execute(
          sql`
      select i.action_invocation_id as "dispatchInvocationId",i.principal_id as "principalId",i.tenant_id as "tenantId",i.legal_entity_id as "governanceLegalEntityId",
        e.domain_event_id as "domainEventId",m.outbox_message_id as "messageId",d.outbox_delivery_id as "deliveryId",e.subject_resource_id as "measureId",
        e.payload_json as "eventPayload",m.payload_json as "messagePayload",d.claimed_by as "claimId",
        (d.status='processing' and d.claim_expires_at>now()) as "claimActive"
      from core.action_invocations i
      join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='human'
      join core.tenants t on t.tenant_id=i.tenant_id and t.status='active'
      join core.legal_entities l on l.tenant_id=i.tenant_id and l.legal_entity_id=i.legal_entity_id and l.status='active'
      join core.domain_events e on e.tenant_id=i.tenant_id and e.action_invocation_id=i.action_invocation_id and e.legal_entity_id=i.legal_entity_id
      join core.outbox_messages m on m.tenant_id=e.tenant_id and m.domain_event_id=e.domain_event_id
      join core.outbox_deliveries d on d.outbox_message_id=m.outbox_message_id
      where i.tenant_id=${input.tenantId}::uuid and i.action_key=${dispatchActionKey} and i.status='succeeded' and ${selection}
        and e.producer_module_key=${privacyModule} and e.subject_module_key=${privacyModule} and e.subject_resource_type='privacy.core.privacy-measure'
        and e.event_type=${outboxTopic} and m.topic=${outboxTopic} and m.producer_module_key=${privacyModule}
        and d.consumer_module_key=${input.consumer.moduleKey} and d.worker_key=${input.consumer.workerKey}
      limit 2`,
          'objects',
        );
        const parsed = yield* Schema.decodeUnknownEffect(Schema.Array(rowSchema), { onExcessProperty: 'error' })(
          rows,
        ).pipe(Effect.mapError(delegationUnavailable));
        const [row] = parsed;
        if (
          parsed.length !== 1 ||
          row === undefined ||
          !isSupportedHandoff(input.consumer, row.messagePayload.handoff, { ...row, handoff: row.eventPayload.handoff })
        ) {
          return yield* delegationForbidden();
        }
        return row;
      }),
    )
    .pipe(
      recoverSqlTransactionError,
      Effect.mapError((cause) => (Schema.is(GatewayDelegationError)(cause) ? cause : delegationUnavailable(cause))),
    );
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
    Effect.mapError(delegationForbidden),
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
    return yield* delegationForbidden();
  }
  const privacy = installed.contracts.find((contract) => contract.manifest.module.id === privacyModule);
  const descriptor = privacy?.manifest.publicSurface.actions.find((action) => action.actionKey === dispatchActionKey);
  if (descriptor?.accessDeclaration === undefined || descriptor.legalEntityScope !== 'required') {
    return yield* delegationForbidden();
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
          ? delegationUnavailable(cause)
          : delegationForbidden(cause),
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
    return yield* delegationUnavailable();
  }
  if (decision.outcome !== 'ALLOWED') {
    return yield* delegationForbidden();
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
    catch: (cause) => delegationForbidden(cause),
    try: jwtVerify.bind(undefined, Redacted.value(input.assertion), configuration.keys, {
      algorithms: ['EdDSA'],
      audience: input.binding.sourceAppId,
      clockTolerance: 0,
      currentDate: DateTime.toDateUtc(now),
      issuer: configuration.issuer,
    }),
  }).pipe(Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(delegationUnavailable()) }));
  yield* decodeGatewayContextProtectedHeader(verified.protectedHeader).pipe(Effect.mapError(delegationForbidden));
  const claims = yield* decodeSupportedGatewayContextClaims(verified.payload).pipe(
    Effect.mapError(delegationForbidden),
  );
  if (
    !('privacyDispatch' in claims) ||
    claims.iat > Math.floor(DateTime.toEpochMillis(now) / 1000) ||
    !bindingAttestsSource(input.binding, claims, input.installed.composition.revision)
  ) {
    return yield* delegationForbidden();
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
    return yield* delegationForbidden();
  }
  const resolved = resolvePublishedFiniteGatewayTarget(destination, approvedTarget);
  if (Option.isNone(resolved)) {
    return yield* delegationForbidden();
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
          return yield* delegationForbidden();
        }
        const row = yield* loadRow({ consumer, deliveryId: proof.deliveryId, tenantId: proof.tenantId });
        if (
          !workerClaimMatches(row, proof.claimId) ||
          !conditionalAllows(source, consumer.workerKey, destination, target, subject.operationRequirementKey)
        ) {
          return yield* delegationForbidden();
        }
        return {
          claimId: proof.claimId,
          consumer,
          row,
          sourceAccess: 'background' as const,
          sourceMode: 'worker' as const,
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
          return yield* delegationForbidden();
        }
        const row = yield* loadRow({
          consumer,
          dispatchInvocationId: proof.dispatchInvocationId,
          tenantId: proof.tenantId,
        });
        if (row.governanceLegalEntityId !== proof.legalEntityId) {
          return yield* delegationForbidden();
        }
        return { consumer, row, sourceAccess: 'read' as const, sourceMode: 'dispatch' as const };
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
          return yield* delegationForbidden();
        }
        const row = yield* loadRow({ consumer, deliveryId: previous.deliveryId, tenantId: previous.tenantId });
        if (
          !sameNativeEvidence(row, previous) ||
          !workerClaimMatches(row, previous.claimId) ||
          claims.principal.tenantId !== row.tenantId ||
          claims.principal.principalId !== row.principalId ||
          claims.principal.legalEntityId !== row.governanceLegalEntityId
        ) {
          return yield* delegationForbidden();
        }
        if ((yield* requestHash(originalOperation.value, row.messagePayload.handoff)) !== previous.requestHash) {
          return yield* delegationForbidden();
        }
        return {
          claimId: previous.claimId,
          consumer,
          row,
          sourceAccess: previousContract.access,
          sourceMode: 'worker' as const,
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
  const metadata =
    'claimId' in admittedSource
      ? {
          ...base,
          claimId: admittedSource.claimId,
          workerKey: admittedSource.consumer.workerKey,
          workerModuleKey: admittedSource.consumer.moduleKey,
        }
      : base;
  const privacyDispatch = yield* Schema.decodeUnknownEffect(RegisteredGatewayPrivacyDispatchSchema)(metadata).pipe(
    Effect.mapError(delegationForbidden),
  );
  if (privacyDispatch.target !== undefined) {
    Object.freeze(privacyDispatch.target);
  }
  return new AdmittedPrivacyDispatchValue(mintKey, {
    principal: Object.freeze({ ...principal }),
    privacyDispatch: Object.freeze(privacyDispatch),
    sourceAccess: admittedSource.sourceAccess,
    sourceKey: row.deliveryId,
  });
});
