import type { CoreDatabase } from '@app/core-runtime/db/client';
import { sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

type Transaction = Parameters<Parameters<(typeof CoreDatabase)['Service']['executor']['transaction']>[0]>[0];
const uuid = Schema.String.check(Schema.isUUID());
const bounded = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max), Schema.isTrimmed());
const inputSchema = Schema.Struct({
  jobId: uuid.pipe(Schema.brand('SymmyImportJobId')),
  operatorName: bounded(200),
  outboxMessageId: uuid.pipe(Schema.brand('OutboxMessageId')),
  reason: bounded(2000),
  tenantId: uuid.pipe(Schema.brand('TenantId')),
});
export type SymmyProvisionCancellationInput = typeof inputSchema.Encoded;
type Cancellation = typeof inputSchema.Type;

export class SymmyProvisionCancellationError extends Schema.TaggedError<SymmyProvisionCancellationError>()(
  'SymmyProvisionCancellationError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}
const refused = (reason: string) => new SymmyProvisionCancellationError({ reason });

const schemaRefusal = (reason: string) => (cause: Schema.SchemaError) =>
  new SymmyProvisionCancellationError({ cause, reason });

const lockPendingProvision = Effect.fn('SymmyAdministration.lockPendingProvision')(function* lockPendingProvision(
  transaction: Transaction,
  input: Cancellation,
) {
  const jobs = yield* transaction
    .execute(
      sql`
      select j.admission_invocation_id as "admissionId", d.status, d.attempts_count as attempts,
        d.claimed_by is null and d.claimed_at is null and d.claim_expires_at is null as unclaimed,
        f.state as "fenceState",
        i.status = 'succeeded' and i.action_key = 'integration.symmy.admit-symmy-job'
          and i.principal_id = j.principal_id
          and i.legal_entity_id is not distinct from j.legal_entity_id as "validAdmission",
        (select count(*)::int from symmy_integration.import_jobs other
          where other.tenant_id=j.tenant_id and other.admission_invocation_id=j.admission_invocation_id) as siblings
      from symmy_integration.import_jobs j
      join core.action_invocations i on i.tenant_id=j.tenant_id
        and i.action_invocation_id=j.admission_invocation_id
      join core.source_execution_fences f on f.tenant_id=j.tenant_id
        and f.admission_invocation_id=j.admission_invocation_id
      join core.outbox_messages m on m.tenant_id=j.tenant_id and m.outbox_message_id=${input.outboxMessageId}::uuid
        and m.producer_module_key='integration.symmy' and m.topic='integration.symmy.job-admitted.v1'
        and m.payload_json=jsonb_build_object('jobId',j.job_id::text)
      join core.domain_events event on event.tenant_id=m.tenant_id and event.domain_event_id=m.domain_event_id
        and event.action_invocation_id=j.admission_invocation_id
      join core.outbox_deliveries d on d.outbox_message_id=m.outbox_message_id
        and d.worker_key='integration.symmy.execute-symmy-job' and d.consumer_module_key='integration.symmy'
      where j.tenant_id=${input.tenantId}::uuid and j.job_id=${input.jobId}::uuid
        and j.route_key='productsBatch'
      for update of j,m,d
    `,
      'objects',
    )
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              admissionId: uuid.pipe(Schema.brand('ActionInvocationId')),
              attempts: Schema.Int,
              fenceState: Schema.String,
              siblings: Schema.Int,
              status: Schema.String,
              unclaimed: Schema.Boolean,
              validAdmission: Schema.Boolean,
            }),
          ),
        ),
      ),
    );
  const [job] = jobs;
  if (
    jobs.length !== 1 ||
    job === undefined ||
    !job.validAdmission ||
    job.siblings !== 1 ||
    job.status !== 'pending' ||
    job.attempts < 1 ||
    !job.unclaimed
  ) {
    return yield* refused(
      'Only the exact tried, unclaimed pending product job with its genuine admission may be cancelled',
    );
  }
  return job;
});

const lockUnsettledProvision = Effect.fn('SymmyAdministration.lockUnsettledProvision')(function* lockUnsettledProvision(
  transaction: Transaction,
  input: Cancellation,
  fenceState: string,
) {
  const effects = yield* transaction
    .execute(
      sql`
      select e.effect_id as "effectId", e.state, e.version,
        e.claim_token is null and e.lease_until is null as unclaimed,
        e.owner_invocation_id is null and e.owner_receipt is null as "noReceipt",
        e.owner_executor_principal_id is not null and e.owner_auth_context_ref is not null
          and e.owner_request_hash ~ '^[0-9a-f]{64}$' as "requestRecorded",
        e.effect#>>'{ref,operation,moduleId}' as owner,
        e.effect#>>'{ref,operation,entrypointKey}' as action,
        e.resolved_effect#>>'{intent,_tag}' as intent
      from symmy_integration.job_effects e
      where e.tenant_id=${input.tenantId}::uuid and e.job_id=${input.jobId}::uuid
      order by e.effect_id for update
    `,
      'objects',
    )
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              action: Schema.String,
              effectId: uuid.pipe(Schema.brand('SymmyJobEffectId')),
              intent: Schema.OptionFromNullOr(Schema.String),
              noReceipt: Schema.Boolean,
              owner: Schema.String,
              requestRecorded: Schema.OptionFromNullOr(Schema.Boolean),
              state: Schema.String,
              unclaimed: Schema.Boolean,
              version: Schema.Int,
            }),
          ),
        ),
      ),
    );
  if (effects.length === 0 || effects.some((effect) => !effect.unclaimed || effect.state === 'attempting')) {
    return yield* refused('Every effect must be present and entirely unclaimed');
  }
  const unsettled = effects.filter((effect) => effect.state !== 'settled');
  const [effect] = unsettled;
  if (
    unsettled.length !== 1 ||
    effect === undefined ||
    effect.state !== 'indeterminate' ||
    !effect.noReceipt ||
    Option.getOrUndefined(effect.requestRecorded) !== true ||
    effect.owner !== 'commerce.inventory' ||
    effect.action !== 'commerce.inventory.provision-source-stock-item' ||
    Option.getOrUndefined(effect.intent) !== 'InventoryProvision' ||
    fenceState !== 'open'
  ) {
    return yield* refused(
      'Cancellation only admits one uncertain, never-receipted native Inventory provisioning remainder',
    );
  }
  return effect;
});

/**
 * Administrative withdrawal of a never-invoked provisioning remainder, not a successful import.
 * The caller MUST propagate failure to roll back its transaction. No Outbox row, accepted receipt,
 * payload or completion debt is changed. The normal worker alone finishes the partially accepted job.
 */
export const cancelNeverInvokedSymmyProvision = Effect.fn('SymmyAdministration.cancelNeverInvokedProvision')(
  function* cancel(transaction: Transaction, rawInput: SymmyProvisionCancellationInput) {
    const input = yield* Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: 'error' })(rawInput).pipe(
      Effect.mapError(schemaRefusal('An exact job, delivery, tenant and bounded operator reason are required')),
    );
    const facts = yield* transaction
      .execute(
        sql`
      select session_user::text as "recordedBy",
        current_setting('transaction_isolation') = 'read committed' as "readCommitted",
        has_table_privilege(session_user, 'symmy_integration.job_effects', 'UPDATE')
          and has_table_privilege(session_user, 'core.audit_events', 'INSERT')
          and has_table_privilege(session_user, 'core.outbox_delivery_resolutions', 'INSERT')
          and not row_security_active('core.action_invocations')
          and not row_security_active('symmy_integration.job_effects') as administrative
    `,
        'objects',
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                administrative: Schema.Boolean,
                readCommitted: Schema.Boolean,
                recordedBy: bounded(200),
              }),
            ),
          ),
        ),
      );
    const [identity] = facts;
    if (facts.length !== 1 || identity?.administrative !== true || !identity.readCommitted) {
      return yield* refused('Cancellation requires an unrestricted native administrator and READ COMMITTED');
    }
    yield* transaction.execute(sql`set local lock_timeout = '5s'`);
    const job = yield* lockPendingProvision(transaction, input);
    const effect = yield* lockUnsettledProvision(transaction, input, job.fenceState);
    // This is the existing native admission barrier, not an invented invocation or an observational absence.
    // UPDATE waits for owner SHARE locks; subsequent owner preparation/execution refuses the permanent cancellation.
    yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${input.tenantId}, true)`);
    const cancelled = yield* transaction
      .execute(
        sql`
      select allowed from trust.cancel_source_execution_fence(${input.tenantId}::uuid, ${job.admissionId}::uuid)
    `,
        'objects',
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ allowed: Schema.Boolean })))));
    if (cancelled.length !== 1 || cancelled[0]?.allowed !== true) {
      return yield* refused('The native original-admission cancellation barrier did not close');
    }
    // A new READ COMMITTED observation AFTER the barrier includes commits that the UPDATE waited for.
    // Any invocation under this globally unique effect key is refused, even with an unexpected actor or hash.
    const invocations = yield* transaction.execute(
      sql`
      select action_invocation_id from core.action_invocations
      where tenant_id=${input.tenantId}::uuid and idempotency_key=${effect.effectId}
      limit 1
    `,
      'objects',
    );
    if (invocations.length !== 0) {
      return yield* refused('An actual owner invocation exists; reconcile its receipt instead of cancelling it');
    }
    const changed = yield* transaction.execute(
      sql`
      update symmy_integration.job_effects set state='settled',
        outcome=jsonb_build_object('effectId',effect_id::text,'owner','commerce.inventory','status','denied'),
        version=version+1
      where tenant_id=${input.tenantId}::uuid and job_id=${input.jobId}::uuid
        and effect_id=${effect.effectId}::uuid and state='indeterminate' and version=${effect.version}
        and claim_token is null and lease_until is null and owner_invocation_id is null and owner_receipt is null
      returning effect_id
    `,
      'objects',
    );
    if (changed.length !== 1) {
      return yield* refused('The exact fenced effect changed before the cancellation decision');
    }
    const evidence = {
      ...input,
      acceptedReceiptsRetained: true,
      admissionId: job.admissionId,
      completionDebtUnchanged: true,
      disposition: 'PERMANENT_EXECUTION_DENIAL',
      effectId: effect.effectId,
      outboxUnchanged: true,
      previousVersion: effect.version,
      recordedBy: identity.recordedBy,
    };
    const evidenceJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(evidence).pipe(
      Effect.mapError(schemaRefusal('The exact operator evidence could not be encoded')),
    );
    yield* transaction.execute(sql`
      insert into core.audit_events
        (tenant_id,principal_id,action_invocation_id,auth_method,event_type,audit_profile,outcome,
          outcome_stage,outcome_code,target_module_key,target_resource_type,target_resource_id,evidence_json)
      values (${input.tenantId}::uuid,null,null,'system','integration.symmy.provisioning.operator-cancelled',
        'sensitive','succeeded','system','never_invoked_provision_permanently_denied',
        'integration.symmy','integration.symmy.job-effect',${effect.effectId},${evidenceJson}::jsonb)
    `);
    return { admissionId: job.admissionId, effectId: effect.effectId, jobId: input.jobId, outcome: 'denied' as const };
  },
);
