import { CoreDatabase } from '@app/core-runtime/db/client';
import { OntosModuleIdSchema, recoverSqlTransactionError } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayWorkloadSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { sql } from 'drizzle-orm';
import { Effect, Match, Option, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import {
  gatewayRegisteredAdmissionOperationContractAllows,
  gatewayRegisteredOperationContractAllows,
  gatewayRegisteredWorkerOperationContractAllows,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding, GatewayRegisteredWorkloadRule } from './gateway-delegation-policy.ts';
import type { GatewayDelegationRequestPayload } from './gateway-delegation-issuer.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';

type WorkloadSubject = Extract<
  GatewayDelegationRequestPayload['subject'],
  { readonly _tag: 'RegisteredWorkload' | 'RegisteredAdmission' }
>;
type WorkerSubject = Extract<WorkloadSubject, { readonly _tag: 'RegisteredWorkload' }>;
const workloadFields = RegisteredGatewayWorkloadSchema.fields;
const actionKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand('GatewaySourceActionKey'),
  Schema.decodeTo(Schema.String),
);
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('GatewayLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const RowSchema = Schema.Struct({
  actionInvocationId: workloadFields.admissionInvocationId,
  bindingIncarnation: Schema.String.check(Schema.isUUID()),
  principalId: TrustedPrincipalContextSchema.fields.principalId,
});
const claimRowsSchema = Schema.Array(
  Schema.Struct({
    actionInvocationId: workloadFields.admissionInvocationId,
    consumerModuleKey: OntosModuleIdSchema,
    producerModuleKey: OntosModuleIdSchema,
    topic: Schema.NonEmptyString,
    workerKey: OntosModuleIdSchema,
  }),
);
const originalRowSchema = Schema.Struct({
  actionKey: actionKeySchema,
  bindingIncarnation: Schema.String.check(Schema.isUUID()),
  legalEntityId: Schema.OptionFromNullOr(legalEntityIdSchema),
  ownerBindingIncarnation: Schema.String.check(Schema.isUUID()),
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  workloadKey: workloadFields.workloadKey,
});
type OriginalRow = typeof originalRowSchema.Type;
type SourceContract = ShellInstalledCatalog['contracts'][number];
const subjectMatchesRule = (subject: WorkloadSubject, rule: GatewayRegisteredWorkloadRule): boolean =>
  Match.value(subject).pipe(
    Match.tag(
      'RegisteredWorkload',
      (worker) => rule.workerKey === worker.workerKey && rule.sourceActionKey === undefined,
    ),
    Match.tag(
      'RegisteredAdmission',
      (admission) => rule.sourceActionKey === admission.sourceActionKey && rule.workerKey === undefined,
    ),
    Match.exhaustive,
  );
const sourceActionKeyOf = (subject: WorkloadSubject): Option.Option<string> =>
  Match.value(subject).pipe(
    Match.tag('RegisteredWorkload', Option.none<string>),
    Match.tag('RegisteredAdmission', (admission) => Option.some(admission.sourceActionKey)),
    Match.exhaustive,
  );
const runReferenceOf = (subject: WorkloadSubject): string =>
  Match.value(subject).pipe(
    Match.tag('RegisteredWorkload', (worker) => worker.deliveryId),
    Match.tag('RegisteredAdmission', (admission) => admission.actionInvocationId),
    Match.exhaustive,
  );
const originalIsAllowed = (
  original: OriginalRow,
  source: SourceContract,
  actionKey: Option.Option<string>,
): boolean => {
  const actions = new Set(source.manifest.originatorActions);
  return (
    actions.has(original.actionKey) &&
    (Option.isNone(actionKey) || original.actionKey === actionKey.value) &&
    source.manifest.publicSurface.actions.some(
      (action) =>
        action.actionKey === original.actionKey &&
        action.accessWorkload?.workloads.some((key) => key === original.workloadKey) === true,
    )
  );
};
const admissionAuthContextMatches = (subject: WorkloadSubject, authContextRef: string | undefined): boolean =>
  Match.value(subject).pipe(
    Match.tag('RegisteredWorkload', () => true),
    Match.tag(
      'RegisteredAdmission',
      (admission) =>
        admission.expectedAuthContextRef === undefined || admission.expectedAuthContextRef === authContextRef,
    ),
    Match.exhaustive,
  );

const completeWorkload = (
  subject: WorkloadSubject,
  moduleKey: string,
  workload: RegisteredGatewayWorkload,
): RegisteredGatewayWorkload => {
  const scoped = subject.legalEntityId === undefined ? workload : { ...workload, legalEntityId: subject.legalEntityId };
  return Match.value(subject).pipe(
    Match.tag('RegisteredWorkload', (worker) => ({
      ...scoped,
      claimId: worker.claimId,
      workerKey: worker.workerKey,
      workerModuleKey: moduleKey,
    })),
    Match.tag('RegisteredAdmission', () => scoped),
    Match.exhaustive,
  );
};

/** Independently proves a current durable delivery, exact source/destination contract and one enrolled system actor. */
export const admitRegisteredGatewayWorkload = Effect.fn('GatewayDelegation.admitRegisteredWorkload')(
  function* admitRegisteredWorkload(input: {
    readonly audience: string;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly subject: WorkloadSubject;
  }) {
    const { binding, installed, subject } = input;
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    const candidates = (binding.registeredWorkloads ?? []).filter(
      (rule) =>
        rule.recoveryOf === undefined &&
        rule.allowRecoverySource !== true &&
        rule.audience === input.audience &&
        subjectMatchesRule(subject, rule) &&
        rule.declarationKey === subject.declarationKey,
    );
    const [rule] = candidates;
    if (
      candidates.length !== 1 ||
      rule === undefined ||
      source === undefined ||
      destination === undefined ||
      binding.compositionRevision !== installed.composition.revision ||
      binding.sourceBuildMarker !== source.deployment.buildMarker
    ) {
      return yield* delegationForbidden();
    }
    if (
      subject.operationRequirementKey === undefined &&
      !gatewayRegisteredOperationContractAllows(source, destination, rule, subject.legalEntityId)
    ) {
      return yield* delegationForbidden();
    }
    const database = yield* CoreDatabase;
    return yield* database.executor
      .transaction(
        Effect.fn('GatewayDelegation.workloadEvidence')(function* workloadEvidence(transaction) {
          yield* transaction
            .execute(
              sql`select set_config('ontos.tenant_id', ${subject.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
              'objects',
            )
            .pipe(recoverSqlTransactionError, Effect.mapError(delegationUnavailable));
          const runReference = runReferenceOf(subject);
          const actionInvocationId = yield* Match.value(subject).pipe(
            Match.tag('RegisteredAdmission', (admission) => Effect.succeed(admission.actionInvocationId)),
            Match.tag(
              'RegisteredWorkload',
              Effect.fn('GatewayDelegation.workerAdmission')(function* workerAdmission(worker: WorkerSubject) {
                const claims = yield* transaction
                  .execute(
                    sql`
        select e.action_invocation_id as "actionInvocationId", d.worker_key as "workerKey", d.consumer_module_key as "consumerModuleKey", m.producer_module_key as "producerModuleKey", m.topic
        from core.outbox_deliveries d
        join core.outbox_messages m on m.outbox_message_id = d.outbox_message_id
        join core.domain_events e on e.domain_event_id = m.domain_event_id and e.tenant_id = m.tenant_id
        where d.outbox_delivery_id = ${runReference}::uuid
          and d.worker_key = ${worker.workerKey} and d.consumer_module_key = ${source.manifest.module.id}
          and m.producer_module_key = ${source.manifest.module.id} and m.tenant_id = ${worker.tenantId}::uuid
          and d.status = 'processing' and d.claimed_by = ${worker.claimId} and d.claim_expires_at > now()
        limit 2
      `,
                    'objects',
                  )
                  .pipe(
                    recoverSqlTransactionError,
                    Effect.mapError(delegationUnavailable),
                    Effect.flatMap((rows) =>
                      Schema.decodeUnknownEffect(claimRowsSchema)(rows).pipe(Effect.mapError(delegationUnavailable)),
                    ),
                  );
                const [claim] = claims;
                if (claims.length !== 1 || claim === undefined) {
                  return yield* delegationForbidden();
                }
                if (
                  worker.operationRequirementKey !== undefined &&
                  !gatewayRegisteredWorkerOperationContractAllows(source, destination, rule, worker.legalEntityId, {
                    ...claim,
                    requirementKey: worker.operationRequirementKey,
                  })
                ) {
                  return yield* delegationForbidden();
                }
                return claim.actionInvocationId;
              }),
            ),
            Match.exhaustive,
          );
          const systems = yield* transaction
            .execute(
              sql`
      select b.incarnation as "bindingIncarnation", p.principal_id as "principalId", ${actionInvocationId} as "actionInvocationId"
      from core.access_workload_bindings b
      join core.tenants t on t.tenant_id = b.tenant_id and t.status = 'active'
      join core.principals p on p.tenant_id = b.tenant_id and p.principal_id = b.principal_id and p.kind = 'system' and p.status = 'active'
      where b.tenant_id = ${subject.tenantId}::uuid and b.workload_key = ${rule.workloadKey} and b.status = 'active'
      limit 2
    `,
              'objects',
            )
            .pipe(
              recoverSqlTransactionError,
              Effect.mapError(delegationUnavailable),
              Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(Schema.Array(RowSchema))(rows).pipe(Effect.mapError(delegationUnavailable)),
              ),
            );
          const [row] = systems;
          if (
            systems.length !== 1 ||
            row === undefined ||
            (subject.expectedPrincipalId !== undefined && row.principalId !== subject.expectedPrincipalId)
          ) {
            return yield* delegationForbidden();
          }
          // The admitted integration identity outlives ingress credential rotation. Only its current
          // registered source workload and active Principal govern fresh effects.
          const originals = yield* transaction
            .execute(
              sql`
      select i.action_key as "actionKey", i.principal_id as "principalId", i.legal_entity_id as "legalEntityId",
        b.workload_key as "workloadKey", b.incarnation as "bindingIncarnation", ob.incarnation as "ownerBindingIncarnation"
      from core.action_invocations i
      join core.principals p on p.tenant_id = i.tenant_id and p.principal_id = i.principal_id
        and p.kind = 'integration' and p.status = 'active'
      join core.access_workload_bindings b on b.tenant_id = p.tenant_id and b.principal_id = p.principal_id and b.status = 'active'
      join core.access_workload_bindings ob on ob.tenant_id = p.tenant_id and ob.principal_id = p.principal_id and ob.status = 'active' and ob.workload_key = ${rule.workloadKey}
      where i.tenant_id = ${subject.tenantId}::uuid and i.action_invocation_id = ${row.actionInvocationId}::uuid and i.status = 'succeeded'
    `,
              'objects',
            )
            .pipe(
              recoverSqlTransactionError,
              Effect.mapError(delegationUnavailable),
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Schema.Array(originalRowSchema))(result).pipe(
                  Effect.mapError(delegationUnavailable),
                ),
              ),
            );
          const actionKey = sourceActionKeyOf(subject);
          const eligible = originals.filter((original) => originalIsAllowed(original, source, actionKey));
          const [original] = eligible;
          if (
            eligible.length !== 1 ||
            original === undefined ||
            (subject.legalEntityId !== undefined &&
              Option.getOrUndefined(original.legalEntityId) !== subject.legalEntityId)
          ) {
            return yield* delegationForbidden();
          }
          const admissionContractAllows = Match.value(subject).pipe(
            Match.tag('RegisteredWorkload', () => true),
            Match.tag(
              'RegisteredAdmission',
              (admission) =>
                admission.operationRequirementKey === undefined ||
                gatewayRegisteredAdmissionOperationContractAllows(source, destination, rule, admission.legalEntityId, {
                  admissionActionKey: original.actionKey,
                  requirementKey: admission.operationRequirementKey,
                }),
            ),
            Match.exhaustive,
          );
          if (!admissionContractAllows) {
            return yield* delegationForbidden();
          }
          if (subject.legalEntityId !== undefined) {
            const companies = yield* transaction
              .execute(
                sql`select legal_entity_id from core.legal_entities where tenant_id = ${subject.tenantId}::uuid and legal_entity_id = ${subject.legalEntityId}::uuid and status = 'active'`,
                'objects',
              )
              .pipe(recoverSqlTransactionError, Effect.mapError(delegationUnavailable));
            if (companies.length !== 1) {
              return yield* delegationForbidden();
            }
          }
          const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authContextRef: `job:${rule.jobKey}:run:${runReference}`,
            authMethod: 'system',
            principalId: row.principalId,
            tenantId: subject.tenantId,
          }).pipe(Effect.mapError(delegationForbidden));
          if (!admissionAuthContextMatches(subject, principal.authContextRef)) {
            return yield* delegationForbidden();
          }
          const workload: RegisteredGatewayWorkload = {
            admissionInvocationId: actionInvocationId,
            bindingIncarnation: row.bindingIncarnation,
            declarationKey: rule.declarationKey,
            entrypointKey: rule.entrypointKey,
            jobKey: rule.jobKey,
            legalEntityScope: rule.legalEntityScope,
            originalOwnerBindingIncarnation: original.ownerBindingIncarnation,
            originalPrincipalId: original.principalId,
            originalWorkloadBindingIncarnation: original.bindingIncarnation,
            originalWorkloadKey: original.workloadKey,
            runReference,
            schemaVersion: rule.schemaVersion,
            sourceAppId: binding.sourceAppId,
            sourceBuildMarker: binding.sourceBuildMarker,
            sourceMode: Match.value(subject).pipe(
              Match.tag('RegisteredWorkload', () => 'worker' as const),
              Match.tag('RegisteredAdmission', () => 'admission' as const),
              Match.exhaustive,
            ),
            workloadKey: rule.workloadKey,
          };
          return {
            principal,
            sourceKey: runReference,
            workload: completeWorkload(subject, source.manifest.module.id, workload),
          };
        }),
      )
      .pipe(
        recoverSqlTransactionError,
        Effect.mapError((cause) => (Schema.is(GatewayDelegationError)(cause) ? cause : delegationUnavailable(cause))),
      );
  },
);
