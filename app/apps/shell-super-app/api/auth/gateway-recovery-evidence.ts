import { OntosModuleIdSchema, recoverSqlTransactionError } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayWorkloadSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/symmy-integration/outbox/integration-symmy-job-admitted-v1';
import { sql } from 'drizzle-orm';
import { Effect, Match, Option, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import type { GatewayDelegationRequestPayload } from './gateway-delegation-issuer.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import {
  gatewayPublishedOperationAccess,
  gatewayRegisteredAdmissionOperationContractAllows,
  gatewayRegisteredOperationContractAllows,
  gatewayRegisteredWorkerOperationContractAllows,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding, GatewayRegisteredWorkloadRule } from './gateway-delegation-policy.ts';

type RecoverySubject = Extract<GatewayDelegationRequestPayload['subject'], { readonly _tag: 'RegisteredRecovery' }>;
type RecoverySource = RecoverySubject['source'];
type InstalledContract = ShellInstalledCatalog['contracts'][number];
type OriginalAction = InstalledContract['manifest']['publicSurface']['actions'][number];
const workloadFields = RegisteredGatewayWorkloadSchema.fields;
const sourceActionKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand('GatewaySourceActionKey'),
  Schema.decodeTo(Schema.String),
);
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('GatewayRecoveryLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const sourceRowsSchema = Schema.Array(
  Schema.Struct({
    actionInvocationId: workloadFields.admissionInvocationId,
    actionKey: sourceActionKeySchema,
    deliveryEvidence: Schema.optionalKey(
      Schema.Struct({
        consumerModuleKey: OntosModuleIdSchema,
        producerModuleKey: OntosModuleIdSchema,
        topic: Schema.NonEmptyString,
        workerKey: OntosModuleIdSchema,
      }),
    ),
    historicalEvidence: Schema.optionalKey(
      Schema.Struct({
        eventPayload: OutboxPayloadSchema,
        messagePayload: OutboxPayloadSchema,
        subjectResourceId: OutboxPayloadSchema.fields.jobId,
        subjectResourceType: Schema.Literal('integration.symmy.import-job'),
        topic: Schema.Literal(outboxTopic),
      }),
    ),
    legalEntityId: Schema.OptionFromNullOr(legalEntityIdSchema),
    principalId: TrustedPrincipalContextSchema.fields.principalId,
  }),
);
const ownerRowsSchema = Schema.Array(Schema.Struct({ actionInvocationId: workloadFields.admissionInvocationId }));
const systemRowsSchema = Schema.Array(
  Schema.Struct({
    bindingIncarnation: Schema.String.check(Schema.isUUID()),
    principalId: TrustedPrincipalContextSchema.fields.principalId,
  }),
);

type SourceRow = (typeof sourceRowsSchema.Type)[number];

const sourceMatchesRule = (source: RecoverySource, rule: GatewayRegisteredWorkloadRule): boolean =>
  Match.value(source).pipe(
    Match.tag(
      'Worker',
      (worker) =>
        rule.workerKey === worker.workerKey &&
        rule.sourceActionKey === undefined &&
        rule.sourceWorkloadKey === undefined,
    ),
    Match.tag(
      'HistoricalDelivery',
      (delivery) =>
        rule.allowHistoricalDeliveryRecovery === true &&
        rule.workerKey === delivery.workerKey &&
        rule.recoveryOf?.jobKey === delivery.workerKey &&
        rule.sourceActionKey === undefined &&
        rule.sourceWorkloadKey === undefined,
    ),
    Match.tag(
      'Admission',
      (admission) =>
        rule.sourceActionKey === admission.sourceActionKey &&
        rule.workerKey === undefined &&
        rule.sourceWorkloadKey === undefined,
    ),
    Match.exhaustive,
  );

/** The historical witness currently supports only this published, versioned Symmy job envelope. */
const historicalSourceContractAllows = (source: InstalledContract, proof: RecoverySource): boolean =>
  Match.value(proof).pipe(
    Match.tag(
      'HistoricalDelivery',
      (delivery) =>
        source.manifest.module.id === outboxProducerModuleKey &&
        source.manifest.publicSurface.resourceTypes.some(
          (resource) => resource.key === 'integration.symmy.import-job',
        ) &&
        source.runtime.outboxSubscriptions.some(
          (subscription) =>
            subscription.workerKey === delivery.workerKey &&
            subscription.consumerModuleKey === outboxProducerModuleKey &&
            subscription.producerModuleKey === outboxProducerModuleKey &&
            subscription.topic === outboxTopic,
        ),
    ),
    Match.tag('Worker', () => true),
    Match.tag('Admission', () => true),
    Match.exhaustive,
  );
const historicalAdmissionMatches = (row: SourceRow, proof: RecoverySource): boolean =>
  Match.value(proof).pipe(
    Match.tag('HistoricalDelivery', () => {
      const evidence = row.historicalEvidence;
      return (
        evidence !== undefined &&
        evidence.eventPayload.jobId === evidence.messagePayload.jobId &&
        evidence.eventPayload.jobId === evidence.subjectResourceId
      );
    }),
    Match.tag('Worker', () => true),
    Match.tag('Admission', () => true),
    Match.exhaustive,
  );

const recoveryRunReference = (source: RecoverySource): string =>
  Match.value(source).pipe(
    Match.tag('Worker', (worker) => worker.deliveryId),
    Match.tag('HistoricalDelivery', (delivery) => delivery.deliveryId),
    Match.tag('Admission', (admission) => admission.actionInvocationId),
    Match.exhaustive,
  );

const recoveryMode = (source: RecoverySource): RegisteredGatewayWorkload['sourceMode'] =>
  Match.value(source).pipe(
    Match.tag('Worker', () => 'worker' as const),
    Match.tag('HistoricalDelivery', () => 'historical_delivery' as const),
    Match.tag('Admission', () => 'admission' as const),
    Match.exhaustive,
  );

const readContractAllowsRecovery = (
  source: InstalledContract,
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  legalEntityId: string | undefined,
  operationRequirementKey: string | undefined,
): boolean => {
  const access = gatewayPublishedOperationAccess(destination, rule.entrypointKey, rule.schemaVersion);
  const read = access === 'read' || access === 'historical_read';
  const write = destination.manifest.publicSurface.actions.some(
    (action) => action.entrypoint.entrypointKey === rule.entrypointKey,
  );
  return (
    read &&
    !write &&
    (operationRequirementKey !== undefined ||
      gatewayRegisteredOperationContractAllows(source, destination, rule, legalEntityId))
  );
};

/** A conditional recovery checks only the already proved source; it never reconstructs an active lease. */
const conditionalRecoveryContractAllows = (input: {
  readonly admission: SourceRow;
  readonly destination: InstalledContract;
  readonly proof: RecoverySource;
  readonly requirementKey: string;
  readonly rule: GatewayRegisteredWorkloadRule;
  readonly source: InstalledContract;
}): boolean => {
  const { admission, destination, proof, requirementKey, rule, source } = input;
  const delivery = admission.deliveryEvidence;
  const workerAllows = () =>
    delivery !== undefined &&
    gatewayRegisteredWorkerOperationContractAllows(source, destination, rule, proof.legalEntityId, {
      ...delivery,
      requirementKey,
    });
  return Match.value(proof).pipe(
    Match.tag('Worker', workerAllows),
    Match.tag('HistoricalDelivery', workerAllows),
    Match.tag('Admission', () =>
      gatewayRegisteredAdmissionOperationContractAllows(source, destination, rule, proof.legalEntityId, {
        admissionActionKey: admission.actionKey,
        requirementKey,
      }),
    ),
    Match.exhaustive,
  );
};

const sourceAdmissionIsDeclared = (row: SourceRow, source: InstalledContract, proof: RecoverySource): boolean => {
  const permitted =
    source.manifest.originatorActions?.some((actionKey) => actionKey === row.actionKey) === true &&
    source.manifest.publicSurface.actions.some((action) => action.actionKey === row.actionKey);
  return (
    permitted &&
    Match.value(proof).pipe(
      Match.tag('Worker', () => true),
      Match.tag('HistoricalDelivery', () => true),
      Match.tag('Admission', (admission) => row.actionKey === admission.sourceActionKey),
      Match.exhaustive,
    )
  );
};

/** Owner scope is determined by its historical Action contract, independently of the receipt Read. */
const originalCompanyOf = (action: OriginalAction, admission: SourceRow): Option.Option<string> =>
  action.legalEntityScope === 'forbidden' ? Option.none() : admission.legalEntityId;

const recoveryCompanyMatches = (
  action: OriginalAction,
  admission: SourceRow,
  proof: RecoverySource,
  rule: GatewayRegisteredWorkloadRule,
): boolean => {
  const ownerCompany = originalCompanyOf(action, admission);
  if (action.legalEntityScope === 'required' && Option.isNone(ownerCompany)) {
    return false;
  }
  if (rule.legalEntityScope === 'forbidden') {
    return proof.legalEntityId === undefined;
  }
  if (rule.legalEntityScope === 'optional') {
    return proof.legalEntityId === Option.getOrUndefined(ownerCompany);
  }
  const requiredCompany = Option.orElse(ownerCompany, () => admission.legalEntityId);
  return Option.isSome(requiredCompany) && proof.legalEntityId === requiredCompany.value;
};

const recoveryWorkloadScope = (
  source: RecoverySource,
  moduleKey: string,
  workload: RegisteredGatewayWorkload,
): RegisteredGatewayWorkload => {
  const scoped = source.legalEntityId === undefined ? workload : { ...workload, legalEntityId: source.legalEntityId };
  return Match.value(source).pipe(
    Match.tag('Worker', (worker) => ({
      ...scoped,
      claimId: worker.claimId,
      workerKey: worker.workerKey,
      workerModuleKey: moduleKey,
    })),
    Match.tag('HistoricalDelivery', (delivery) => ({
      ...scoped,
      workerKey: delivery.workerKey,
      workerModuleKey: moduleKey,
    })),
    Match.tag('Admission', () => scoped),
    Match.exhaustive,
  );
};

/** A historical native owner invocation authorizes one exact receipt Read, never a new owner command. */
export const admitRegisteredGatewayRecovery = Effect.fn('GatewayDelegation.admitRegisteredRecovery')(
  function* registeredRecovery(input: {
    readonly audience: string;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly subject: RecoverySubject;
  }) {
    const { binding, installed, subject } = input;
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    const candidates = (binding.registeredWorkloads ?? []).filter(
      (rule) =>
        rule.audience === input.audience &&
        rule.declarationKey === subject.declarationKey &&
        rule.recoveryOf?.actionKey === subject.originalActionKey &&
        sourceMatchesRule(subject.source, rule),
    );
    const [rule] = candidates;
    if (
      candidates.length !== 1 ||
      rule?.recoveryOf === undefined ||
      source === undefined ||
      destination === undefined ||
      binding.compositionRevision !== installed.composition.revision ||
      binding.sourceBuildMarker !== source.deployment.buildMarker
    ) {
      return yield* delegationForbidden('registered_workload_unmatched')();
    }
    const originalAction = destination.manifest.publicSurface.actions.find(
      (action) => action.actionKey === subject.originalActionKey,
    );
    if (
      !readContractAllowsRecovery(
        source,
        destination,
        rule,
        subject.source.legalEntityId,
        subject.operationRequirementKey,
      ) ||
      originalAction === undefined ||
      !historicalSourceContractAllows(source, subject.source)
    ) {
      return yield* delegationForbidden('registered_operation_refused')();
    }
    const { recoveryOf } = rule;
    const database = yield* CoreDatabase;
    const runReference = recoveryRunReference(subject.source);
    return yield* database.executor
      .transaction(
        Effect.fn('GatewayDelegation.recoveryEvidence')(function* recoveryEvidence(transaction) {
          const { source: proof } = subject;
          yield* transaction
            .execute(
              sql`select set_config('ontos.tenant_id', ${proof.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
              'objects',
            )
            .pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
          const sourceStatement = Match.value(proof).pipe(
            Match.tag(
              'Worker',
              (worker) => sql`
          select i.action_invocation_id as "actionInvocationId", i.action_key as "actionKey", i.legal_entity_id as "legalEntityId", i.principal_id as "principalId",
            jsonb_build_object('consumerModuleKey',d.consumer_module_key,'producerModuleKey',m.producer_module_key,'topic',m.topic,'workerKey',d.worker_key) as "deliveryEvidence"
          from core.outbox_deliveries d
          join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
          join core.domain_events e on e.domain_event_id=m.domain_event_id and e.tenant_id=m.tenant_id
          join core.action_invocations i on i.tenant_id=m.tenant_id and i.action_invocation_id=e.action_invocation_id and i.status='succeeded'
          join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='integration'
          where d.outbox_delivery_id=${worker.deliveryId}::uuid and d.worker_key=${worker.workerKey} and d.claimed_by=${worker.claimId}
            and d.consumer_module_key=${source.manifest.module.id} and m.producer_module_key=${source.manifest.module.id}
            and m.tenant_id=${worker.tenantId}::uuid and d.status='processing' and d.claim_expires_at>now()
          limit 2`,
            ),
            Match.tag(
              'HistoricalDelivery',
              (delivery) => sql`
          select i.action_invocation_id as "actionInvocationId", i.action_key as "actionKey", i.legal_entity_id as "legalEntityId", i.principal_id as "principalId",
            jsonb_build_object('consumerModuleKey',d.consumer_module_key,'producerModuleKey',m.producer_module_key,'topic',m.topic,'workerKey',d.worker_key) as "deliveryEvidence",
            jsonb_build_object('eventPayload',e.payload_json,'messagePayload',m.payload_json,'subjectResourceId',e.subject_resource_id,'subjectResourceType',e.subject_resource_type,'topic',m.topic) as "historicalEvidence"
          from core.outbox_deliveries d
          join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
          join core.domain_events e on e.domain_event_id=m.domain_event_id and e.tenant_id=m.tenant_id
          join core.action_invocations i on i.tenant_id=m.tenant_id and i.action_invocation_id=e.action_invocation_id and i.status='succeeded'
          join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='integration'
          where d.outbox_delivery_id=${delivery.deliveryId}::uuid and d.worker_key=${delivery.workerKey}
            and d.consumer_module_key=${outboxProducerModuleKey} and m.producer_module_key=${outboxProducerModuleKey}
            and e.producer_module_key=${outboxProducerModuleKey} and e.subject_module_key=${outboxProducerModuleKey}
            and m.topic=${outboxTopic} and e.event_type=${outboxTopic}
            and m.tenant_id=${delivery.tenantId}::uuid and e.legal_entity_id is not distinct from i.legal_entity_id
          limit 2`,
            ),
            Match.tag(
              'Admission',
              (admission) => sql`
          select i.action_invocation_id as "actionInvocationId", i.action_key as "actionKey", i.legal_entity_id as "legalEntityId", i.principal_id as "principalId"
          from core.action_invocations i
          join core.principals p on p.tenant_id=i.tenant_id and p.principal_id=i.principal_id and p.kind='integration'
          where i.tenant_id=${admission.tenantId}::uuid and i.action_invocation_id=${admission.actionInvocationId}::uuid
            and i.action_key=${admission.sourceActionKey} and i.status='succeeded'
          limit 2`,
            ),
            Match.exhaustive,
          );
          const admissions = yield* transaction.execute(sourceStatement, 'objects').pipe(
            Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
            Effect.flatMap((rows) =>
              Schema.decodeUnknownEffect(sourceRowsSchema, { onExcessProperty: 'error' })(rows).pipe(
                Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              ),
            ),
          );
          const [admission] = admissions;
          if (
            admissions.length !== 1 ||
            admission === undefined ||
            !sourceAdmissionIsDeclared(admission, source, proof) ||
            !historicalAdmissionMatches(admission, proof) ||
            !recoveryCompanyMatches(originalAction, admission, proof, rule)
          ) {
            return yield* delegationForbidden('workload_source_not_admitted')();
          }
          if (
            subject.operationRequirementKey !== undefined &&
            !conditionalRecoveryContractAllows({
              admission,
              destination,
              proof,
              requirementKey: subject.operationRequirementKey,
              rule,
              source,
            })
          ) {
            return yield* delegationForbidden('conditional_requirement_refused')();
          }
          const ownerLegalEntityId = Option.getOrUndefined(originalCompanyOf(originalAction, admission));
          const originalAuthContextRef = `job:${recoveryOf.jobKey}:run:${runReference}`;
          const originals = yield* transaction
            .execute(
              sql`
        select i.action_invocation_id as "actionInvocationId"
        from core.action_invocations i
        where i.tenant_id=${proof.tenantId}::uuid and i.principal_id=${subject.originalPrincipalId}::uuid
          and i.action_key=${subject.originalActionKey} and i.idempotency_key=${subject.originalIdempotencyKey}
          and i.request_hash=${subject.originalRequestHash} and i.auth_method='system' and i.auth_context_ref=${originalAuthContextRef}
          and i.legal_entity_id is not distinct from ${ownerLegalEntityId ?? null}::uuid
        limit 2`,
              'objects',
            )
            .pipe(
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(ownerRowsSchema)(rows).pipe(
                  Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                ),
              ),
            );
          const [original] = originals;
          if (originals.length !== 1 || original === undefined) {
            return yield* delegationForbidden('recovery_original_unmatched')();
          }
          const systems = yield* transaction
            .execute(
              sql`
        select b.principal_id as "principalId", b.incarnation as "bindingIncarnation"
        from core.access_workload_bindings b
        join core.principals p on p.tenant_id=b.tenant_id and p.principal_id=b.principal_id and p.kind='system' and p.status='active'
        join core.tenants t on t.tenant_id=b.tenant_id and t.status='active'
        where b.tenant_id=${proof.tenantId}::uuid and b.workload_key=${rule.workloadKey} and b.status='active'
          and (${proof.legalEntityId ?? null}::uuid is null or exists(select 1 from core.legal_entities l where l.tenant_id=t.tenant_id and l.legal_entity_id=${proof.legalEntityId ?? null}::uuid and l.status='active'))
        limit 2`,
              'objects',
            )
            .pipe(
              Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
              Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(systemRowsSchema)(rows).pipe(
                  Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
                ),
              ),
            );
          const [system] = systems;
          if (
            systems.length !== 1 ||
            system === undefined ||
            (subject.expectedPrincipalId !== undefined && system.principalId !== subject.expectedPrincipalId)
          ) {
            return yield* delegationForbidden('workload_binding_not_active')();
          }
          const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authContextRef: `job:${rule.jobKey}:run:${runReference}`,
            authMethod: 'system',
            principalId: system.principalId,
            tenantId: proof.tenantId,
          }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
          const workload: RegisteredGatewayWorkload = {
            admissionInvocationId: admission.actionInvocationId,
            bindingIncarnation: system.bindingIncarnation,
            declarationKey: rule.declarationKey,
            entrypointKey: rule.entrypointKey,
            jobKey: rule.jobKey,
            legalEntityScope: rule.legalEntityScope,
            originalPrincipalId: admission.principalId,
            recovery: {
              originalActionInvocationId: original.actionInvocationId,
              originalActionKey: subject.originalActionKey,
              originalAuthContextRef,
              originalIdempotencyKey: subject.originalIdempotencyKey,
              originalPrincipalId: subject.originalPrincipalId,
              originalRequestHash: subject.originalRequestHash,
              requestHash: subject.requestHash,
            },
            runReference,
            schemaVersion: rule.schemaVersion,
            sourceAppId: binding.sourceAppId,
            sourceBuildMarker: binding.sourceBuildMarker,
            sourceMode: recoveryMode(proof),
            workloadKey: rule.workloadKey,
          };
          return {
            principal,
            sourceKey: runReference,
            workload: recoveryWorkloadScope(proof, source.manifest.module.id, workload),
          };
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError((cause) =>
          Schema.is(GatewayDelegationError)(cause)
            ? cause
            : delegationUnavailable('source_evidence_unavailable')(cause),
        ),
      );
  },
);
