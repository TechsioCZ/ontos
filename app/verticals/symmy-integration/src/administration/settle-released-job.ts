import { sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import {
  cancelAdmissionFence,
  refused,
  requireNativeAdministrator,
  schemaRefusal,
  SymmyJobOperatorInputSchema,
} from './cancel-never-invoked-provision.ts';
import type { SymmyAdministrationTransaction } from './cancel-never-invoked-provision.ts';

export type SymmyReleasedJobSettlementInput = typeof SymmyJobOperatorInputSchema.Encoded;
type Settlement = typeof SymmyJobOperatorInputSchema.Type;

const uuid = Schema.String.check(Schema.isUUID());
const EffectIdSchema = uuid.pipe(Schema.brand('SymmyJobEffectId'));
const ItemIdSchema = uuid.pipe(Schema.brand('SymmyJobItemId'));
const InvocationIdSchema = uuid.pipe(Schema.brand('ActionInvocationId'));
const EffectKeySchema = Schema.String.pipe(Schema.brand('SymmyJobEffectKey'));
const ItemKeySchema = Schema.String.pipe(Schema.brand('SymmyJobItemKey'));
/** A planned dependency; an absent item key names an effect of the same item. */
const DependencySchema = Schema.Struct({
  effectKey: EffectKeySchema,
  itemKey: Schema.OptionFromNullOr(ItemKeySchema),
});
export const SymmyReleasedJobEffectSchema = Schema.Struct({
  dependsOn: Schema.Array(DependencySchema),
  effectId: EffectIdSchema,
  effectKey: EffectKeySchema,
  executorPrincipalId: Schema.OptionFromNullOr(uuid),
  itemId: ItemIdSchema,
  noReceipt: Schema.Boolean,
  requestHash: Schema.OptionFromNullOr(Schema.String),
  state: Schema.String,
  status: Schema.OptionFromNullOr(Schema.String),
  unclaimed: Schema.Boolean,
  version: Schema.Int,
});
export type SymmyReleasedJobEffect = typeof SymmyReleasedJobEffectSchema.Type;
export const SymmyReleasedJobItemSchema = Schema.Struct({ itemId: ItemIdSchema, itemKey: ItemKeySchema });
export type SymmyReleasedJobItem = typeof SymmyReleasedJobItemSchema.Type;

const accepted = new Set(['accepted_change', 'accepted_no_change', 'duplicate']);

/**
 * What the native worker would have settled each unfinished effect as, had it still run: an effect whose dependency
 * ends anything but accepted is `unsupported` (its owner context is missing), and every other unfinished effect is
 * withdrawn, `denied`. Settled effects keep their outcome.
 */
export const releasedJobSettlement = (
  effects: readonly SymmyReleasedJobEffect[],
  items: readonly SymmyReleasedJobItem[],
): ReadonlyMap<string, 'denied' | 'unsupported'> => {
  const itemIdOf = new Map(items.map(({ itemId, itemKey }) => [itemKey, itemId]));
  const byKey = new Map(effects.map((effect) => [`${effect.itemId}\u0000${effect.effectKey}`, effect]));
  const final = new Map<string, string>();
  const statusOf = (effect: SymmyReleasedJobEffect, visiting: ReadonlySet<string>): string => {
    const known = final.get(effect.effectId);
    if (known !== undefined) {
      return known;
    }
    if (effect.state === 'settled') {
      return Option.getOrElse(effect.status, () => 'unsupported');
    }
    const dependencies = effect.dependsOn.map(({ effectKey, itemKey }) =>
      byKey.get(
        `${Option.match(itemKey, { onNone: () => effect.itemId, onSome: (key) => itemIdOf.get(key) ?? '' })}\u0000${effectKey}`,
      ),
    );
    const next = new Set([...visiting, effect.effectId]);
    const rejected = dependencies.some(
      (dependency) =>
        dependency === undefined || next.has(dependency.effectId) || !accepted.has(statusOf(dependency, next)),
    );
    const status = rejected ? 'unsupported' : 'denied';
    final.set(effect.effectId, status);
    return status;
  };
  return new Map(
    effects.flatMap((effect) =>
      effect.state === 'settled'
        ? []
        : [[effect.effectId, statusOf(effect, new Set()) === 'unsupported' ? 'unsupported' : 'denied'] as const],
    ),
  );
};

/** The job, its genuine single-job admission, and the named execution delivery, which an operator released. */
const lockReleasedJob = Effect.fn('SymmyAdministration.lockReleasedJob')(function* lockReleasedJob(
  transaction: SymmyAdministrationTransaction,
  input: Settlement,
) {
  const jobs = yield* transaction
    .execute(
      sql`
      select j.admission_invocation_id as "admissionId", f.state as "fenceState",
        d.status = 'released' and d.claimed_by is null and d.claimed_at is null as released,
        i.status = 'succeeded' and i.action_key = 'integration.symmy.admit-symmy-job'
          and i.principal_id = j.principal_id
          and i.legal_entity_id is not distinct from j.legal_entity_id as "validAdmission",
        (select count(*)::int from symmy_integration.import_jobs other
          where other.tenant_id=j.tenant_id and other.admission_invocation_id=j.admission_invocation_id) as siblings,
        (select count(*)::int from core.outbox_messages other_message
          join core.outbox_deliveries other_delivery on other_delivery.outbox_message_id=other_message.outbox_message_id
          where other_message.tenant_id=j.tenant_id and other_message.producer_module_key='integration.symmy'
            and other_message.topic='integration.symmy.job-admitted.v1'
            and other_message.payload_json=jsonb_build_object('jobId',j.job_id::text)
            and other_delivery.status <> 'released') as "liveDeliveries"
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
      for update of j,m,d
    `,
      'objects',
    )
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              admissionId: InvocationIdSchema,
              fenceState: Schema.String,
              liveDeliveries: Schema.Int,
              released: Schema.Boolean,
              siblings: Schema.Int,
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
    !job.released ||
    job.liveDeliveries !== 0 ||
    (job.fenceState !== 'open' && job.fenceState !== 'cancelled')
  ) {
    return yield* refused(
      'Only a job with its genuine admission whose every execution delivery an operator released may be settled',
    );
  }
  return job;
});

const lockUnfinishedEffects = Effect.fn('SymmyAdministration.lockUnfinishedEffects')(function* lockEffects(
  transaction: SymmyAdministrationTransaction,
  input: Settlement,
) {
  // One transaction connection answers one statement at a time; the effect rows are locked before the plan is read.
  const { effects, items } = yield* Effect.all(
    {
      effects: transaction
        .execute(
          sql`
      select e.effect_id as "effectId", e.effect_key as "effectKey", e.item_id as "itemId", e.state, e.version,
        e.outcome->>'status' as status,
        e.claim_token is null and e.lease_until is null as unclaimed,
        e.owner_invocation_id is null and e.owner_receipt is null as "noReceipt",
        e.owner_executor_principal_id::text as "executorPrincipalId", e.owner_request_hash as "requestHash",
        coalesce((select jsonb_agg(case when jsonb_typeof(dependency)='string'
            then jsonb_build_object('effectKey',dependency#>>'{}','itemKey',null) else dependency end)
          from jsonb_array_elements(coalesce(e.effect->'dependsOn','[]'::jsonb)) dependency), '[]'::jsonb) as "dependsOn"
      from symmy_integration.job_effects e
      where e.tenant_id=${input.tenantId}::uuid and e.job_id=${input.jobId}::uuid
      order by e.effect_id for update
    `,
          'objects',
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SymmyReleasedJobEffectSchema)))),
      items: transaction
        .execute(
          sql`
      select i->>'itemId' as "itemId", i->>'itemKey' as "itemKey"
      from symmy_integration.import_jobs j, jsonb_array_elements(j.execution_plan->'items') i
      where j.tenant_id=${input.tenantId}::uuid and j.job_id=${input.jobId}::uuid
    `,
          'objects',
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SymmyReleasedJobItemSchema)))),
    },
    { concurrency: 1 },
  );
  const unfinished = effects.filter((effect) => effect.state !== 'settled');
  if (
    unfinished.length === 0 ||
    effects.some((effect) => !effect.unclaimed) ||
    unfinished.some((effect) => (effect.state !== 'planned' && effect.state !== 'indeterminate') || !effect.noReceipt)
  ) {
    return yield* refused(
      'Every effect must be unclaimed, and every unfinished one planned or uncertain without an owner receipt',
    );
  }
  return { effects, items, unfinished };
});

const InvocationRowSchema = Schema.Struct({
  actionInvocationId: InvocationIdSchema,
  // Every Symmy owner call is made under its effect id as the idempotency key.
  idempotencyKey: EffectIdSchema,
  principalId: Schema.OptionFromNullOr(uuid),
  requestHash: Schema.OptionFromNullOr(Schema.String),
  status: Schema.String,
  uncompleted: Schema.Boolean,
});

/**
 * Settles what is left of a Symmy job whose execution delivery an operator released: a released delivery is
 * terminal, so the native worker never runs the job again and its unfinished effects would stay open for good. The
 * admission fence is cancelled first, so no owner can commit any of them afterwards; an owner invocation that already
 * committed refuses the settlement (its receipt must be reconciled instead). Each unfinished effect is then settled as
 * the worker would: `unsupported` behind a dependency that did not succeed, otherwise `denied`. Accepted work, Core
 * invocations and every Outbox row stay as they are. The caller MUST propagate failure to roll back its transaction.
 */
export const settleReleasedSymmyJob = Effect.fn('SymmyAdministration.settleReleasedJob')(function* settle(
  transaction: SymmyAdministrationTransaction,
  rawInput: SymmyReleasedJobSettlementInput,
) {
  const input = yield* Schema.decodeUnknownEffect(SymmyJobOperatorInputSchema, { onExcessProperty: 'error' })(
    rawInput,
  ).pipe(Effect.mapError(schemaRefusal('An exact job, delivery, tenant and bounded operator reason are required')));
  const recordedBy = yield* requireNativeAdministrator(transaction);
  const job = yield* lockReleasedJob(transaction, input);
  const { effects, items, unfinished } = yield* lockUnfinishedEffects(transaction, input);
  yield* cancelAdmissionFence(transaction, input.tenantId, job.admissionId);
  // A new READ COMMITTED observation AFTER the barrier includes every commit the cancellation waited for.
  const effectIds = unfinished.map(({ effectId }) => effectId);
  const invocations = yield* transaction
    .execute(
      sql`
      select action_invocation_id as "actionInvocationId", idempotency_key as "idempotencyKey",
        principal_id::text as "principalId", request_hash as "requestHash", status,
        completed_at is null as uncompleted
      from core.action_invocations
      where tenant_id=${input.tenantId}::uuid and idempotency_key = any(${`{${effectIds.join(',')}}`}::text[])
    `,
      'objects',
    )
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(InvocationRowSchema))));
  if (
    invocations.some((invocation) => {
      const effect = unfinished.find(({ effectId }) => effectId === invocation.idempotencyKey);
      return (
        effect === undefined ||
        Option.getOrNull(invocation.principalId) !== Option.getOrNull(effect.executorPrincipalId) ||
        Option.getOrNull(invocation.requestHash) !== Option.getOrNull(effect.requestHash) ||
        invocation.status !== 'received' ||
        !invocation.uncompleted
      );
    })
  ) {
    return yield* refused('An owner invocation committed, ended or differs; reconcile its receipt instead of settling');
  }
  const settlement = releasedJobSettlement(effects, items);
  // One statement at a time on the transaction connection, each guarded by the version it locked.
  yield* Effect.forEach(
    unfinished,
    Effect.fnUntraced(function* settleEffect(effect) {
      const status = settlement.get(effect.effectId);
      const outcome =
        status === 'unsupported'
          ? sql`jsonb_build_object('owner',effect#>>'{ref,operation,moduleId}','reason','missing_context','status','unsupported')`
          : sql`jsonb_build_object('effectId',effect_id::text,'owner',effect#>>'{ref,operation,moduleId}','status','denied')`;
      const changed = yield* transaction.execute(
        sql`
      update symmy_integration.job_effects set state='settled', outcome=${outcome}, version=version+1
      where tenant_id=${input.tenantId}::uuid and job_id=${input.jobId}::uuid
        and effect_id=${effect.effectId}::uuid and state=${effect.state} and version=${effect.version}
        and claim_token is null and lease_until is null and owner_invocation_id is null and owner_receipt is null
      returning effect_id
    `,
        'objects',
      );
      if (changed.length !== 1) {
        return yield* refused('An unfinished effect changed before the settlement decision');
      }
      return yield* Effect.void;
    }),
    { concurrency: 1, discard: true },
  );
  const outcomeOf = (wanted: 'denied' | 'unsupported') =>
    unfinished.flatMap(({ effectId }) => (settlement.get(effectId) === wanted ? [effectId] : []));
  const evidence = {
    ...input,
    acceptedReceiptsRetained: true,
    admissionId: job.admissionId,
    deniedEffectIds: outcomeOf('denied'),
    disposition: 'PERMANENT_EXECUTION_DENIAL',
    outboxUnchanged: true,
    recordedBy,
    uncommittedInvocationIds: invocations.map(({ actionInvocationId }) => actionInvocationId),
    unsupportedEffectIds: outcomeOf('unsupported'),
  };
  const evidenceJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(evidence).pipe(
    Effect.mapError(schemaRefusal('The exact operator evidence could not be encoded')),
  );
  yield* transaction.execute(sql`
      insert into core.audit_events
        (tenant_id,principal_id,action_invocation_id,auth_method,event_type,audit_profile,outcome,
          outcome_stage,outcome_code,target_module_key,target_resource_type,target_resource_id,evidence_json)
      values (${input.tenantId}::uuid,null,null,'system','integration.symmy.job.operator-settled',
        'sensitive','succeeded','system','released_job_remainder_permanently_denied',
        'integration.symmy','integration.symmy.import-job',${input.jobId},${evidenceJson}::jsonb)
    `);
  return {
    admissionId: job.admissionId,
    denied: evidence.deniedEffectIds.length,
    jobId: input.jobId,
    uncommittedInvocations: invocations.length,
    unsupported: evidence.unsupportedEffectIds.length,
  };
});
