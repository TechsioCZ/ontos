import { defineScopedRoutine, registeredAdmissionAuthContextRef } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { readVerifiedGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import {
  openScopedSourceExecutionFence,
  readScopedOriginalActionInvocation,
  readScopedSourceExecutionFence,
  readScopedSystemWorkloadEnrollment,
  requireScopedSourceExecutionFenceOpen,
} from '@app/core-runtime/access/enforcement';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import { Array as EffectArray, Config, Duration, Effect, Match, Option, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import {
  SymmyFixtureExecutionPlanSchema,
  SymmyJobExecutionProjectionSchema,
  SymmyPinnedJobPlanSchema,
} from '../../shared/domain/symmy-job-execution.ts';
import type {
  SymmyFixtureExecutionPlan,
  SymmyPinnedEffect,
  SymmyPinnedJobPlan,
} from '../../shared/domain/symmy-job-execution.ts';

import {
  symmyImportJobs,
  symmyJobEffects,
  symmyJobRoutes,
  symmySyncAdmissionAttempts,
  symmySyncAdmissions,
} from '../db/schema.ts';
import type { SymmyDurableRouteKey } from '../db/schema.ts';
import { projectSymmyExecutionJob, symmyJobExecutionStore } from './symmy-job-execution-store.ts';
import {
  SymmyPartyCommerceIntentSchema,
  materializeSymmyPartyCommerceIntent,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';
import {
  prepareSymmyCatalogPricingInventoryRequestHash,
  materializeSymmyCatalogPricingInventorySourceOccurrence,
} from '../services/symmy-catalog-pricing-inventory-adapters.ts';
import { prepareSymmyPartyCommerceRequestHash } from '../services/symmy-party-commerce-adapters.ts';
import {
  SymmyCatalogPricingInventoryIntentSchema,
  SymmyInventoryImportIntentSchema,
} from '../../shared/domain/symmy-catalog-pricing-inventory-intents.ts';
import { decodeSymmySourceSelector, verifySymmySourceSelector } from '../../shared/domain/symmy-source-selector.ts';
import { AdmitSymmySyncPayloadSchema, AdmitSymmySyncResultSchema } from '../../shared/actions/admit-symmy-sync.ts';
import type { SymmyDecodedSourceSelector } from '../../shared/domain/symmy-source-selector.ts';
import {
  mapSymmyPolicyFixtureIntent,
  SymmyPolicyFixtureIntentSchema,
  SymmyPolicyFixtureRouteKeySchema,
} from '../../shared/domain/symmy-policy-fixture-intents.ts';
import { symmyExecutionRegistration } from '../services/symmy-worker-identity.service.ts';
import { SymmyRouteContextResponseSchema } from '../../shared/apis/symmy-route-context.ts';

export class SymmyJobStoreError extends Schema.TaggedError<SymmyJobStoreError>()('SymmyJobStoreError', {
  code: Schema.Literals(['route_denied', 'idempotency_conflict', 'stock_assertion_denied', 'unavailable']),
}) {}

export interface SymmyJobAdmissionRequest {
  readonly code?: string;
  readonly contractVersion?: 'INTERNAL_C14';
  readonly fixtureId?: string;
  readonly idempotencyKey: string;
  readonly plan?: SymmyFixtureExecutionPlan;
  readonly routeKey: SymmyDurableRouteKey;
}

const unavailable = (cause?: unknown) => {
  const error = new SymmyJobStoreError({ code: 'unavailable' });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause, writable: false });
};
const routeDenied = (cause?: unknown) => {
  const error = new SymmyJobStoreError({ code: 'route_denied' });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause, writable: false });
};

const hash = (value: string) =>
  Effect.tryPromise({
    catch: unavailable,
    try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, 'SHA-256', new TextEncoder().encode(value)),
  }).pipe(
    Effect.timeoutOrElse({ duration: Duration.seconds(2), orElse: () => Effect.fail(unavailable()) }),
    Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
  );

// A fixed tuple gives every request the same serialization independent of object property order.
const IntentSchema = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.OptionFromNullOr(Schema.String), Schema.String]),
);

const InternalIntentSchema = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.OptionFromNullOr(Schema.String), Schema.String, Schema.String]),
);

const receiptColumns = {
  jobId: symmyImportJobs.jobId,
  phase: symmyImportJobs.phase,
};

const lockEnrollment = defineScopedRoutine({
  name: 'lock_symmy_enrollment_snapshot',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ allowed: Schema.Boolean }),
  routineKey: 'symmy-route.lock-enrollment-snapshot',
  schema: 'symmy_integration',
});
const lockRoute = Effect.fn('SymmyJobStore.lockEnrollment')(function* lockRouteSnapshot(
  transaction: ScopedTransactionExecutor,
  route: typeof symmyJobRoutes.$inferSelect,
) {
  const [locked] = yield* transaction.invoke(lockEnrollment, [route.routeId, route]).pipe(Effect.mapError(unavailable));
  if (locked?.allowed !== true) {
    return yield* routeDenied();
  }
  return yield* Effect.void;
});

const sourceWorkloads = new Map([
  ['commerce.catalog', 'commerce.catalog.symmy-product-import'],
  ['commerce.pricing', 'commerce.pricing.source-write'],
  ['pricing.price-group-catalog', 'pricing.price-group-catalog.source-write'],
  ['commerce.inventory', 'commerce.inventory.source-write'],
  ['party.registry', 'party.registry.source-write'],
  ['commerce.customer-context', 'commerce.customer-context.source-write'],
]);
const sourceWorkloadFor = (moduleId: string) => sourceWorkloads.get(moduleId);
const inputPlanAllowed = (
  template: SymmyFixtureExecutionPlan,
  plan: SymmyFixtureExecutionPlan,
  scope: OperationalScope,
): boolean => {
  if (
    plan.inventoryBackendId !== undefined ||
    plan.pricingSourceSystem !== undefined ||
    plan.sourceRouteId !== undefined ||
    plan.sourceRouteRevision !== undefined ||
    plan.sourceMappingVersion !== undefined ||
    plan.selector !== undefined
  ) {
    return false;
  }
  return plan.items.every(({ effects, source }) => {
    const enrolledEffects = template.items.flatMap(({ effects: allowedEffects, source: allowed }) =>
      allowed.issuerId === source.issuerId &&
      allowed.sourceNamespace === source.sourceNamespace &&
      allowed.entityKind === source.entityKind
        ? allowedEffects
        : [],
    );
    return effects.every(
      ({ intent, operation, originalTarget }) =>
        intent !== undefined &&
        enrolledEffects.some(
          ({ operation: allowed }) =>
            allowed.moduleId === operation.moduleId &&
            allowed.entrypointKey === operation.entrypointKey &&
            allowed.schemaVersion === operation.schemaVersion,
        ) &&
        (originalTarget === undefined ||
          (originalTarget.tenantId === scope.tenantId && originalTarget.moduleId === operation.moduleId)),
    );
  });
};

const requireLifecyclePolicy = Effect.fn('SymmyJobStore.requireLifecyclePolicy')(function* requirePolicy(
  route: typeof symmyJobRoutes.$inferSelect,
  privatePayload: boolean,
) {
  if (!privatePayload) {
    return yield* Effect.void;
  }
  if (route.lifecyclePolicy === null) {
    return yield* routeDenied();
  }
  const configured = yield* Config.option(
    Config.schema(
      Schema.fromJsonString(Schema.Array(SymmyJobRetentionPolicySchema)),
      'ONTOS_SYMMY_JOB_RETENTION_POLICIES',
    ),
  ).pipe(Effect.mapError(unavailable));
  const matches = Option.getOrElse(configured, () => []).filter(
    (policy) =>
      policy.tenantId === route.tenantId &&
      policy.routeId === route.routeId &&
      policy.policyId === route.lifecyclePolicy?.policyId &&
      policy.revision === route.lifecyclePolicy?.revision &&
      Option.getOrNull(policy.targetLegalEntityId) === route.legalEntityId &&
      (route.legalEntityId === null || policy.governanceLegalEntityId === route.legalEntityId),
  );
  if (matches.length !== 1) {
    return yield* routeDenied();
  }
  return yield* Effect.void;
});
const configuredPlan = (
  source: SymmyFixtureExecutionPlan,
  configuration: SymmyFixtureExecutionPlan,
): SymmyFixtureExecutionPlan => {
  const plan: SymmyFixtureExecutionPlan = { items: source.items };
  if (configuration.pricingSourceSystem !== undefined) {
    Object.assign(plan, { pricingSourceSystem: configuration.pricingSourceSystem });
  }
  if (configuration.inventoryBackendId !== undefined) {
    Object.assign(plan, { inventoryBackendId: configuration.inventoryBackendId });
  }
  if (configuration.sourceRouteId !== undefined) {
    Object.assign(plan, { sourceRouteId: configuration.sourceRouteId });
  }
  if (configuration.sourceRouteRevision !== undefined) {
    Object.assign(plan, { sourceRouteRevision: configuration.sourceRouteRevision });
  }
  if (configuration.sourceMappingVersion !== undefined) {
    Object.assign(plan, { sourceMappingVersion: configuration.sourceMappingVersion });
  }
  if (configuration.selector !== undefined) {
    Object.assign(plan, { selector: configuration.selector });
  }
  return plan;
};
const materializePinnedEffect = (effect: SymmyPinnedEffect): SymmyPinnedEffect => {
  if (effect.intent !== undefined && Schema.is(SymmyPartyCommerceIntentSchema)(effect.intent)) {
    return { ...effect, intent: materializeSymmyPartyCommerceIntent(effect.intent, effect.ref) };
  }
  if (effect.intent !== undefined && Schema.is(SymmyCatalogPricingInventoryIntentSchema)(effect.intent)) {
    return {
      ...effect,
      intent: materializeSymmyCatalogPricingInventorySourceOccurrence(
        effect.intent,
        effect.ref.occurrence.occurrenceId,
      ),
    };
  }
  return effect;
};
const materializePinnedPlan = (plan: SymmyPinnedJobPlan): SymmyPinnedJobPlan => ({
  ...plan,
  items: EffectArray.map<SymmyPinnedJobPlan['items'], SymmyPinnedJobPlan['items'][number]>((item) => ({
    ...item,
    effects: EffectArray.map<SymmyPinnedJobPlan['items'][number]['effects'], SymmyPinnedEffect>(
      materializePinnedEffect,
    )(item.effects),
  }))(plan.items),
});

const encodeCallerIntent = Effect.fn('SymmyJobStore.encodeCallerIntent')(function* encodeCallerIntent(
  input: SymmyJobAdmissionRequest,
  fixtureId: string,
) {
  const encodedPlan =
    input.plan === undefined
      ? undefined
      : yield* Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema))(input.plan).pipe(
          Effect.mapError(unavailable),
        );
  return yield* (
    encodedPlan === undefined
      ? Schema.encodeEffect(IntentSchema)([input.routeKey, Option.fromNullishOr(input.code), fixtureId])
      : Schema.encodeEffect(InternalIntentSchema)([
          input.routeKey,
          Option.fromNullishOr(input.code),
          fixtureId,
          encodedPlan,
        ])
  ).pipe(Effect.mapError(unavailable));
});

const policyFixtureTemplateAllowed = (template: SymmyFixtureExecutionPlan, isPolicyFixture: boolean): boolean => {
  if (!isPolicyFixture) {
    return template.items.every(({ effects }) =>
      effects.every(({ intent }) => !Schema.is(SymmyPolicyFixtureIntentSchema)(intent)),
    );
  }
  const [item] = template.items;
  const [effect] = item.effects;
  return (
    template.sourceRouteId === undefined &&
    template.sourceRouteRevision === undefined &&
    template.sourceMappingVersion === undefined &&
    template.selector === undefined &&
    template.inventoryBackendId === undefined &&
    template.pricingSourceSystem === undefined &&
    template.items.length === 1 &&
    item.effects.length === 1 &&
    (item.unsupportedBranches?.length ?? 0) === 0 &&
    (effect.dependsOn?.length ?? 0) === 0 &&
    Schema.is(SymmyPolicyFixtureIntentSchema)(effect.intent)
  );
};

const requirePinnedPolicyFixture = (
  plan: SymmyPinnedJobPlan,
  routeKey: SymmyDurableRouteKey,
  legalEntityId?: string,
) => {
  const [item] = plan.items;
  const [{ intent, ref }] = item.effects;
  return Schema.is(SymmyPolicyFixtureIntentSchema)(intent)
    ? mapSymmyPolicyFixtureIntent(ref, intent, routeKey, legalEntityId).pipe(
        Effect.asVoid,
        Effect.mapError(routeDenied),
      )
    : Effect.fail(routeDenied());
};

const routeSourceAuthority = (
  route: typeof symmyJobRoutes.$inferSelect,
  template: SymmyFixtureExecutionPlan | null,
) => ({
  sourceMappingVersion: template?.sourceMappingVersion ?? route.mappingVersion,
  sourceRouteId: template?.sourceRouteId ?? route.routeId,
  sourceRouteRevision: template?.sourceRouteRevision ?? route.routeRevision,
});

const exactRouteProofMatches = (
  route: typeof symmyJobRoutes.$inferSelect,
  scope: OperationalScope,
  template: SymmyFixtureExecutionPlan | null,
  idempotencyDigest?: string,
): boolean => {
  const proof = readVerifiedGatewayRouteScope(scope);
  if (scope.legalEntityId === undefined) {
    return proof === undefined && route.legalEntityId === null;
  }
  const { sourceMappingVersion, sourceRouteId, sourceRouteRevision } = routeSourceAuthority(route, template);
  return (
    proof !== undefined &&
    proof.tenantId === route.tenantId &&
    proof.principalId === route.principalId &&
    proof.legalEntityId === route.legalEntityId &&
    proof.routeKey === route.routeKey &&
    proof.routeId === route.routeId &&
    proof.routeRevision === route.routeRevision &&
    proof.mappingVersion === route.mappingVersion &&
    (proof.replayIdempotencyDigest === undefined || proof.replayIdempotencyDigest === idempotencyDigest) &&
    proof.sourceRouteId === sourceRouteId &&
    proof.sourceRouteRevision === sourceRouteRevision &&
    proof.sourceMappingVersion === sourceMappingVersion
  );
};
const permitsNewAdmission = (route: typeof symmyJobRoutes.$inferSelect, scope: OperationalScope, fixtureId: string) =>
  route.fixtureIds.includes(fixtureId) && readVerifiedGatewayRouteScope(scope)?.replayIdempotencyDigest === undefined;
const isSyncAdmissionRoute = Schema.is(AdmitSymmySyncPayloadSchema.fields.routeKey);

const selectedPlanMatches = (
  input: SymmyJobAdmissionRequest,
  template: SymmyFixtureExecutionPlan,
  tenantId: string,
): boolean => {
  if (input.code === undefined) {
    return true;
  }
  const { selector } = template;
  return (
    selector?.target !== undefined &&
    selector.source.route.tenantId === tenantId &&
    selector.target.tenantId === tenantId &&
    selector.kind === (input.routeKey === 'priceListPricesBatch' ? 'PRICE_GROUP' : 'CUSTOMER_GROUP')
  );
};

const decodeRouteTemplate = (route: typeof symmyJobRoutes.$inferSelect) =>
  route.fixturePlan === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(route.fixturePlan).pipe(Effect.mapError(unavailable));

const configuredEffectsAllowed = (routeKey: SymmyDurableRouteKey, plan: SymmyFixtureExecutionPlan): boolean => {
  if (routeKey === 'priceListsBatchUpsert' && plan.selector === undefined) {
    return plan.items.every(({ effects }) =>
      effects.every(({ intent }) =>
        Match.value(intent).pipe(
          Match.tag('PriceDefine', 'PriceRevise', () => false),
          Match.orElse(() => true),
        ),
      ),
    );
  }
  if (routeKey === 'customerGroupCustomersBatch') {
    return plan.items.every(({ effects }) =>
      effects.every(({ intent }) =>
        Match.value(intent).pipe(
          Match.tag('CustomerGroupMembership', ({ payload }) => payload.operation === 'ASSIGN'),
          Match.orElse(() => true),
        ),
      ),
    );
  }
  return true;
};

const prepareAdmissionPlan = Effect.fn('SymmyJobStore.prepareAdmissionPlan')(function* prepareAdmissionPlan(
  context: { scope: OperationalScope; transaction: ScopedTransactionExecutor },
  route: typeof symmyJobRoutes.$inferSelect,
  input: SymmyJobAdmissionRequest,
  template: SymmyFixtureExecutionPlan | null,
) {
  const { scope, transaction } = context;
  const isPolicyFixture = Schema.is(SymmyPolicyFixtureRouteKeySchema)(input.routeKey);
  if (
    isPolicyFixture &&
    (input.fixtureId === undefined ||
      input.plan !== undefined ||
      template === null ||
      scope.legalEntityId === undefined)
  ) {
    return yield* routeDenied();
  }
  let preparedPlan: SymmyPinnedJobPlan | null = null;
  if (template !== null) {
    if (!policyFixtureTemplateAllowed(template, isPolicyFixture)) {
      return yield* routeDenied();
    }
    if (input.plan !== undefined && !inputPlanAllowed(template, input.plan, scope)) {
      return yield* routeDenied();
    }
    yield* requireLifecyclePolicy(
      route,
      input.plan !== undefined ||
        template.items.some(({ effects }) => effects.some(({ intent }) => intent !== undefined)),
    );
    if (!selectedPlanMatches(input, template, scope.tenantId)) {
      return yield* routeDenied();
    }
    const plan = configuredPlan(input.plan ?? template, template);
    if (!configuredEffectsAllowed(input.routeKey, plan)) {
      return yield* routeDenied();
    }
    const executionPlanJson = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema))(
      plan,
    ).pipe(Effect.mapError(unavailable));
    const [pinned] = yield* transaction
      .select({
        plan: sql<SymmyPinnedJobPlan>`symmy_integration.pin_symmy_fixture_plan(${executionPlanJson}::jsonb,${symmyJobRoutes.tenantId},${symmyJobRoutes.routeId},${symmyJobRoutes.routeRevision},${symmyJobRoutes.mappingVersion})`.as(
          'plan',
        ),
      })
      .from(symmyJobRoutes)
      .where(and(eq(symmyJobRoutes.tenantId, scope.tenantId), eq(symmyJobRoutes.routeId, route.routeId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (pinned === undefined) {
      return yield* unavailable();
    }
    preparedPlan = materializePinnedPlan(
      yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)(pinned.plan).pipe(Effect.mapError(unavailable)),
    );
    if (isPolicyFixture) {
      yield* requirePinnedPolicyFixture(preparedPlan, input.routeKey, scope.legalEntityId);
    }
  } else if (input.plan !== undefined) {
    return yield* routeDenied();
  }
  return preparedPlan;
});

const syncIntentAllowed = (routeKey: SymmyDurableRouteKey, intent: SymmyPinnedEffect['intent']): boolean => {
  if (intent === undefined) {
    return false;
  }
  return Match.value(intent).pipe(
    Match.tag('InventoryImport', () => routeKey === 'inventoryStockBatch'),
    Match.tag('CustomerGroupCreate', 'CustomerGroupUpdate', () => routeKey !== 'inventoryStockBatch'),
    Match.orElse(() => false),
  );
};

const recoverOriginalEffect = Effect.fn('SymmyJobStore.recoverOriginalEffect')(function* recoverOriginalEffect(
  transaction: ScopedTransactionExecutor,
  effect: SymmyPinnedEffect,
) {
  if (
    effect.executorPrincipalId === undefined ||
    effect.requestHash === undefined ||
    effect.authContextRef === undefined
  ) {
    return effect;
  }
  const fact = yield* readScopedOriginalActionInvocation(transaction, {
    actionKey: effect.ref.operation.entrypointKey,
    authContextRef: effect.authContextRef,
    idempotencyKey: effect.ref.effectId,
    originalPrincipalId: effect.executorPrincipalId,
    requestHash: effect.requestHash,
  }).pipe(Effect.mapError(unavailable));
  return Option.isNone(fact)
    ? effect
    : { ...effect, originalInvocationId: fact.value.actionInvocationId, originalInvocationStatus: fact.value.status };
});
const recoverOriginalItem = Effect.fn('SymmyJobStore.recoverOriginalItem')(function* recoverOriginalItem(
  transaction: ScopedTransactionExecutor,
  item: SymmyPinnedJobPlan['items'][number],
) {
  const effects = yield* Effect.forEach(item.effects, (effect) => recoverOriginalEffect(transaction, effect), {
    concurrency: 1,
  });
  return { ...item, effects };
});
const syncReceipt = Effect.fn('SymmyJobStore.syncReceipt')(function* syncReceipt(
  transaction: ScopedTransactionExecutor,
  saved: typeof symmySyncAdmissions.$inferSelect,
  replayed: boolean,
) {
  if (replayed) {
    const fence = yield* readScopedSourceExecutionFence(transaction, saved.admissionId).pipe(
      Effect.mapError(unavailable),
    );
    if (Option.isNone(fence) || fence.value.state !== 'open') {
      return yield* routeDenied();
    }
  } else {
    yield* requireScopedSourceExecutionFenceOpen(transaction, saved.admissionId).pipe(Effect.mapError(unavailable));
  }
  const original = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)(saved.executionPlan).pipe(
    Effect.mapError(unavailable),
  );
  const items = yield* Effect.forEach(original.items, (item) => recoverOriginalItem(transaction, item), {
    concurrency: 1,
  });
  const plan = yield* Schema.decodeUnknownEffect(Schema.toType(SymmyPinnedJobPlanSchema))({ ...original, items }).pipe(
    Effect.mapError(unavailable),
  );
  const receipt = {
    admissionId: saved.admissionId,
    plan,
    replayed,
    tenantId: saved.tenantId,
  };
  if (saved.legalEntityId !== null) {
    Object.assign(receipt, { legalEntityId: saved.legalEntityId });
  }
  return yield* Schema.decodeUnknownEffect(Schema.toType(AdmitSymmySyncResultSchema))(receipt).pipe(
    Effect.mapError(unavailable),
  );
});
const syncAdmissionReceipt = Effect.fn('SymmyJobStore.syncAdmissionReceipt')(function* syncAdmissionReceipt(
  transaction: ScopedTransactionExecutor,
  saved: typeof symmySyncAdmissions.$inferSelect,
  attempt: { readonly invocationId: string; readonly replayed: boolean },
) {
  const receipt = yield* syncReceipt(transaction, saved, attempt.replayed);
  yield* transaction
    .insert(symmySyncAdmissionAttempts)
    .values({ admissionId: saved.admissionId, invocationId: attempt.invocationId, tenantId: saved.tenantId })
    .onConflictDoNothing()
    .pipe(Effect.mapError(unavailable));
  const [link] = yield* transaction
    .select({ admissionId: symmySyncAdmissionAttempts.admissionId })
    .from(symmySyncAdmissionAttempts)
    .where(
      and(
        eq(symmySyncAdmissionAttempts.tenantId, saved.tenantId),
        eq(symmySyncAdmissionAttempts.invocationId, attempt.invocationId),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (link === undefined || link.admissionId !== saved.admissionId) {
    return yield* unavailable();
  }
  return receipt;
});

const verifySyncReplay = (saved: typeof symmySyncAdmissions.$inferSelect, intentDigest: string) => {
  if (saved.retentionReceipt !== null) {
    return Effect.fail(routeDenied());
  }
  return saved.intentDigest === intentDigest
    ? Effect.void
    : Effect.fail(new SymmyJobStoreError({ code: 'idempotency_conflict' }));
};

interface SyncPrincipalFacts {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}
const syncAdmissionKey = (
  identity: { readonly legalEntityId?: string | null; readonly principalId: string; readonly tenantId: string },
  routeKey: typeof symmySyncAdmissions.$inferSelect.routeKey,
  digest: string,
) =>
  and(
    eq(symmySyncAdmissions.tenantId, identity.tenantId),
    eq(symmySyncAdmissions.routeKey, routeKey),
    eq(symmySyncAdmissions.idempotencyDigest, digest),
    eq(symmySyncAdmissions.principalId, identity.principalId),
    identity.legalEntityId === null || identity.legalEntityId === undefined
      ? isNull(symmySyncAdmissions.legalEntityId)
      : eq(symmySyncAdmissions.legalEntityId, identity.legalEntityId),
  );
interface SyncPinContext {
  readonly authContextRef: string;
  readonly scope: OperationalScope;
  readonly transaction: ScopedTransactionExecutor;
}
const pinSyncEffect = Effect.fn('SymmyJobStore.pinSyncEffect')(function* pinSyncEffect(
  context: SyncPinContext,
  effect: SymmyPinnedEffect,
) {
  const { authContextRef, scope, transaction } = context;
  const workload = sourceWorkloadFor(effect.ref.operation.moduleId);
  if (workload === undefined) {
    return yield* routeDenied();
  }
  const enrollment = yield* readScopedSystemWorkloadEnrollment(transaction, workload).pipe(
    Effect.mapError(unavailable),
  );
  if (
    Option.isNone(enrollment) ||
    effect.intent === undefined ||
    Schema.is(SymmyPolicyFixtureIntentSchema)(effect.intent)
  ) {
    return yield* routeDenied();
  }
  const principalFacts: SyncPrincipalFacts = {
    principalId: enrollment.value.principalId,
    tenantId: scope.tenantId,
  };
  if (scope.legalEntityId !== undefined) {
    Object.assign(principalFacts, { legalEntityId: scope.legalEntityId });
  }
  const requestHash = yield* (
    Schema.is(SymmyCatalogPricingInventoryIntentSchema)(effect.intent)
      ? prepareSymmyCatalogPricingInventoryRequestHash(effect.intent, principalFacts, scope.legalEntityId)
      : prepareSymmyPartyCommerceRequestHash(effect.intent, principalFacts)
  ).pipe(Effect.mapError(unavailable));
  return {
    ...effect,
    authContextRef,
    executorBindingIncarnation: enrollment.value.bindingIncarnation,
    executorPrincipalId: enrollment.value.principalId,
    requestHash,
  };
});
const pinSyncItem = Effect.fn('SymmyJobStore.pinSyncItem')(function* pinSyncItem(
  context: SyncPinContext,
  item: SymmyPinnedJobPlan['items'][number],
) {
  const effects = yield* Effect.forEach(item.effects, (effect) => pinSyncEffect(context, effect), { concurrency: 1 });
  return { ...item, effects };
});

const configuredRouteSelector = (
  decoded: SymmyDecodedSourceSelector | undefined,
  tenantId: string,
  plan: SQLWrapper = symmyJobRoutes.fixturePlan,
) => {
  if (decoded === undefined) {
    return isNull(symmyJobRoutes.routeCode);
  }
  return Match.value(decoded).pipe(
    Match.tag('Legacy', ({ code }) => eq(symmyJobRoutes.routeCode, code)),
    Match.tag('Qualified', ({ code, targetResourceId }) =>
      and(
        sql`${plan} #>> '{selector,target,resourceId}' = ${targetResourceId}`,
        sql`symmy_integration.symmy_source_selector_code(
          ${tenantId}::text,
          ${plan} #>> '{selector,source,issuerId}',
          ${plan} #>> '{selector,source,sourceNamespace}',
          ${plan} #>> '{selector,source,route,integrationRouteId}',
          ${plan} #>> '{selector,kind}',
          ${plan} #>> '{selector,source,sourceRecordId}',
          ${plan} #>> '{selector,target,resourceId}'
        ) = ${code}`,
      ),
    ),
    Match.exhaustive,
  );
};
const qualifiedSelectorMatches = Effect.fn('SymmyJobStore.qualifiedSelectorMatches')(function* qualifiedSelectorMatches(
  decoded: Extract<SymmyDecodedSourceSelector, { _tag: 'Qualified' }>,
  plan: Pick<SymmyFixtureExecutionPlan, 'selector'>,
  scope: OperationalScope,
) {
  const selected = plan.selector;
  if (
    selected === undefined ||
    selected.target === undefined ||
    selected.source.route.tenantId !== scope.tenantId ||
    selected.target.tenantId !== scope.tenantId
  ) {
    return false;
  }
  return yield* verifySymmySourceSelector(
    decoded,
    {
      issuerId: selected.source.issuerId,
      routeId: selected.source.route.integrationRouteId,
      selectorKind: selected.kind,
      sourceNamespace: selected.source.sourceNamespace,
      tenantId: scope.tenantId,
    },
    selected.source.sourceRecordId,
    selected.target.resourceId,
  ).pipe(
    Effect.map(() => true),
    Effect.catchTag('SymmySourceSelectorError', () => Effect.succeed(false)),
  );
});
interface ConfiguredRouteContext {
  readonly allowedOwnerOperations: readonly SymmyFixtureExecutionPlan['items'][number]['effects'][number]['operation'][];
  readonly issuerId: SymmyFixtureExecutionPlan['items'][number]['source']['issuerId'];
  readonly legalEntityId?: string;
  readonly mappingVersion: string;
  readonly replayIdempotencyDigest?: NonNullable<typeof SymmyRouteContextResponseSchema.Type.replayIdempotencyDigest>;
  readonly resolvedCode?: string;
  readonly routeId: string;
  readonly routeRevision: string;
  readonly selector?: SymmyFixtureExecutionPlan['selector'];
  readonly sourceEntityKind?: SymmyFixtureExecutionPlan['items'][number]['source']['entityKind'];
  readonly sourceMappingVersion: string;
  readonly sourceNamespace: SymmyFixtureExecutionPlan['items'][number]['source']['sourceNamespace'];
  readonly sourceRouteId: string;
  readonly sourceRouteRevision: string;
  readonly tenantId: string;
}
const retainedRouteContext = Effect.fn('SymmyJobStore.retainedRouteContext')(function* retainedRouteContext(
  row: typeof symmyJobRoutes.$inferSelect,
  original: SymmyPinnedJobPlan,
  digest: string,
  template: SymmyFixtureExecutionPlan | null = null,
): Effect.fn.Return<ConfiguredRouteContext, SymmyJobStoreError> {
  const [item] = original.items;
  const [effect] = item.effects;
  const { record } = effect.ref.occurrence;
  const replayIdempotencyDigest = yield* Schema.decodeUnknownEffect(
    SymmyRouteContextResponseSchema.fields.replayIdempotencyDigest,
  )(digest).pipe(Effect.mapError(unavailable));
  if (replayIdempotencyDigest === undefined || record.route.tenantId !== row.tenantId) {
    return yield* unavailable();
  }
  const result: ConfiguredRouteContext = {
    allowedOwnerOperations: [],
    issuerId: original.selector?.source.issuerId ?? record.issuerId,
    mappingVersion: row.mappingVersion,
    replayIdempotencyDigest,
    routeId: row.routeId,
    routeRevision: row.routeRevision,
    // The current enrollment is the authority carrier; the retained plan remains the only source for owner effects.
    ...routeSourceAuthority(row, template),
    sourceNamespace: original.selector?.source.sourceNamespace ?? record.sourceNamespace,
    tenantId: row.tenantId,
  };
  if (row.legalEntityId !== null) {
    Object.assign(result, { legalEntityId: row.legalEntityId });
  }
  if (row.routeCode !== null) {
    Object.assign(result, { resolvedCode: row.routeCode });
  }
  if (original.selector !== undefined) {
    Object.assign(result, { selector: original.selector });
  }
  return result;
});
const qualifyRetainedSyncRoute = Effect.fn('SymmyJobStore.qualifyRetainedSyncRoute')(function* qualifyRetainedSyncRoute(
  transaction: ScopedTransactionExecutor,
  row: typeof symmyJobRoutes.$inferSelect,
  digest: string,
): Effect.fn.Return<Option.Option<ConfiguredRouteContext>, SymmyJobStoreError> {
  if (row.fixturePlan !== null || !isSyncAdmissionRoute(row.routeKey) || row.routeCode !== null) {
    return Option.none();
  }
  const [saved, duplicate] = yield* transaction
    .select({ executionPlan: symmySyncAdmissions.executionPlan })
    .from(symmySyncAdmissions)
    .where(and(syncAdmissionKey(row, row.routeKey, digest), isNull(symmySyncAdmissions.retentionReceipt)))
    .limit(2)
    .pipe(Effect.mapError(unavailable));
  if (saved === undefined || duplicate !== undefined) {
    return Option.none();
  }
  const original = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)(saved.executionPlan).pipe(
    Effect.mapError(unavailable),
  );
  return Option.some(yield* retainedRouteContext(row, original, digest));
});
const qualifyRetainedJobRoute = Effect.fn('SymmyJobStore.qualifyRetainedJobRoute')(function* qualifyRetainedJobRoute(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  routeKey: SymmyDurableRouteKey,
  decoded: SymmyDecodedSourceSelector | undefined,
  digest: string,
): Effect.fn.Return<Option.Option<ConfiguredRouteContext>, SymmyJobStoreError> {
  // Only a qualified selector can prove which replaced source the accepted job used.
  const hasQualifiedSelector = Match.value(decoded).pipe(
    Match.tag('Qualified', () => true),
    Match.orElse(() => false),
  );
  const [saved, duplicate] = yield* transaction
    .select({ executionPlan: symmyImportJobs.executionPlan, route: symmyJobRoutes })
    .from(symmyImportJobs)
    .innerJoin(
      symmyJobRoutes,
      and(
        eq(symmyJobRoutes.tenantId, symmyImportJobs.tenantId),
        eq(symmyJobRoutes.principalId, symmyImportJobs.principalId),
        eq(symmyJobRoutes.routeKey, symmyImportJobs.routeKey),
        sql`${symmyJobRoutes.legalEntityId} IS NOT DISTINCT FROM ${symmyImportJobs.legalEntityId}`,
        sql`${symmyJobRoutes.routeCode} IS NOT DISTINCT FROM ${symmyImportJobs.routeCode}`,
      ),
    )
    .where(
      and(
        eq(symmyImportJobs.tenantId, scope.tenantId),
        eq(symmyImportJobs.principalId, scope.principalId),
        eq(symmyImportJobs.routeKey, routeKey),
        eq(symmyImportJobs.idempotencyDigest, digest),
        eq(symmyJobRoutes.active, true),
        hasQualifiedSelector ? undefined : isNull(symmyJobRoutes.fixturePlan),
        configuredRouteSelector(decoded, scope.tenantId, symmyImportJobs.executionPlan),
      ),
    )
    .limit(2)
    .pipe(Effect.mapError(unavailable));
  if (saved === undefined || duplicate !== undefined || saved.executionPlan === null) {
    return Option.none();
  }
  const [original, template] = yield* Effect.all(
    [
      Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)(saved.executionPlan).pipe(Effect.mapError(unavailable)),
      decodeRouteTemplate(saved.route),
    ],
    { concurrency: 2 },
  );
  return Option.some(yield* retainedRouteContext(saved.route, original, digest, template));
});
const qualifyConfiguredRoute = Effect.fn('SymmyJobStore.qualifyConfiguredRoute')(function* qualifyConfiguredRoute(
  context: { readonly decoded: SymmyDecodedSourceSelector | undefined; readonly scope: OperationalScope },
  row: typeof symmyJobRoutes.$inferSelect,
) {
  if (row.fixturePlan === null) {
    return Option.none();
  }
  const { decoded, scope } = context;
  const plan = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(row.fixturePlan).pipe(
    Effect.mapError(unavailable),
  );
  if (decoded !== undefined) {
    const matches = yield* Match.value(decoded).pipe(
      Match.tag('Legacy', () => Effect.succeed(true)),
      Match.tag('Qualified', (qualified) => qualifiedSelectorMatches(qualified, plan, scope)),
      Match.exhaustive,
    );
    if (!matches) {
      return Option.none();
    }
  }
  const [first] = plan.items;
  if (
    plan.items.some(
      ({ source }) =>
        source.issuerId !== first.source.issuerId || source.sourceNamespace !== first.source.sourceNamespace,
    )
  ) {
    return Option.none();
  }
  const result: ConfiguredRouteContext = {
    allowedOwnerOperations: plan.items.flatMap(({ effects }) => effects.map(({ operation }) => operation)),
    issuerId: first.source.issuerId,
    mappingVersion: row.mappingVersion,
    routeId: row.routeId,
    routeRevision: row.routeRevision,
    ...routeSourceAuthority(row, plan),
    sourceNamespace: first.source.sourceNamespace,
    tenantId: scope.tenantId,
  };
  if (row.routeCode !== null) {
    Object.assign(result, { resolvedCode: row.routeCode });
  }
  if (plan.selector !== undefined) {
    Object.assign(result, { selector: plan.selector });
  }
  if (row.legalEntityId !== null) {
    Object.assign(result, { legalEntityId: row.legalEntityId });
  }
  if (plan.items.every(({ source }) => source.entityKind === first.source.entityKind)) {
    Object.assign(result, { sourceEntityKind: first.source.entityKind });
  }
  return Option.some(result);
});

type EnrolledEffects = SymmyFixtureExecutionPlan['items'][number]['effects'];
const sameStockIntent = Schema.toEquivalence(SymmyInventoryImportIntentSchema);
const isStockIntent = Schema.is(SymmyInventoryImportIntentSchema);
const stockIntentMatchesEnrollment = (intent: EnrolledEffects[number]['intent'], allowed: EnrolledEffects) =>
  isStockIntent(intent) && allowed.some(({ intent: exact }) => isStockIntent(exact) && sameStockIntent(intent, exact));

const stockPlanMatchesEnrollment = (plan: SymmyFixtureExecutionPlan, template: SymmyFixtureExecutionPlan): boolean =>
  plan.items.every((item) =>
    template.items.some((enrolled) => {
      if (
        item.sourceOccurrenceId === undefined ||
        item.sourceOccurrenceId !== enrolled.sourceOccurrenceId ||
        item.source.issuerId !== enrolled.source.issuerId ||
        item.source.sourceNamespace !== enrolled.source.sourceNamespace ||
        item.source.entityKind !== enrolled.source.entityKind ||
        item.source.sourceRecordId !== enrolled.source.sourceRecordId
      ) {
        return false;
      }
      return item.effects.every(({ intent }) => stockIntentMatchesEnrollment(intent, enrolled.effects));
    }),
  );

const prepareSyncPlan = Effect.fn('SymmyJobStore.prepareSyncPlan')(function* prepareSyncPlan(
  route: typeof symmyJobRoutes.$inferSelect,
  input: SymmyJobAdmissionRequest,
  scope: OperationalScope,
  template: SymmyFixtureExecutionPlan | null,
) {
  if (template === null || !permitsNewAdmission(route, scope, input.fixtureId ?? 'INTERNAL_C14')) {
    return yield* routeDenied();
  }
  if (input.routeKey === 'inventoryStockBatch' && template.inventoryBackendId === undefined) {
    return yield* routeDenied();
  }
  yield* requireLifecyclePolicy(
    route,
    input.plan !== undefined ||
      template.items.some(({ effects }) => effects.some(({ intent }) => intent !== undefined)),
  );
  const plan = configuredPlan(input.plan ?? template, template);
  if (input.plan !== undefined && !inputPlanAllowed(template, input.plan, scope)) {
    return yield* routeDenied();
  }
  if (input.routeKey === 'inventoryStockBatch' && !stockPlanMatchesEnrollment(plan, template)) {
    return yield* new SymmyJobStoreError({ code: 'stock_assertion_denied' });
  }
  if (plan.items.some(({ effects }) => effects.some(({ intent }) => !syncIntentAllowed(input.routeKey, intent)))) {
    return yield* routeDenied();
  }
  return plan;
});

interface SymmyJobAdmissionReceipt {
  readonly executionReady: boolean;
  readonly inserted: boolean;
  readonly jobId: string;
  readonly phase: 'admitted';
}

type SymmySyncAdmissionReceiptDecoded = typeof AdmitSymmySyncResultSchema.Type;
export interface SymmySyncAdmissionReceipt extends SymmySyncAdmissionReceiptDecoded {
  readonly plan: SymmyPinnedJobPlan;
}

type SymmyJobPollResult = typeof SymmyJobExecutionProjectionSchema.Type;
type BeforeJobInsert<R> = (plan: SymmyPinnedJobPlan) => Effect.Effect<void, SymmyJobStoreError, R>;

const authorizeNewJob = Effect.fn('SymmyJobStore.authorizeNewJob')(function* authorize<R>(
  plan: SymmyPinnedJobPlan | null,
  routeKey: SymmyDurableRouteKey,
  admissionInvocationId: string | undefined,
  beforeInsert: BeforeJobInsert<R> | undefined,
) {
  if (admissionInvocationId === undefined) {
    if (plan?.items.some(({ effects }) => effects.some(({ intent }) => intent !== undefined)) === true) {
      return yield* routeDenied();
    }
    return yield* Effect.void;
  }
  if (plan === null) {
    return yield* routeDenied();
  }
  if (routeKey !== 'customersBatch') {
    return yield* Effect.void;
  }
  if (beforeInsert === undefined) {
    return yield* unavailable();
  }
  return yield* beforeInsert(plan);
});

interface SymmyJobStore {
  readonly admit: <R = never>(
    input: SymmyJobAdmissionRequest,
    admissionInvocationId?: string,
    beforeInsert?: BeforeJobInsert<R>,
  ) => Effect.Effect<SymmyJobAdmissionReceipt, SymmyJobStoreError, R>;
  readonly admitSync: (
    input: SymmyJobAdmissionRequest,
    admissionId: string,
  ) => Effect.Effect<SymmySyncAdmissionReceipt, SymmyJobStoreError>;
  readonly poll: (jobId: string) => Effect.Effect<Option.Option<SymmyJobPollResult>, SymmyJobStoreError>;
  readonly readSyncAdmission: (admissionId: string) => Effect.Effect<SymmySyncAdmissionReceipt, SymmyJobStoreError>;
  readonly routeContext: (input: {
    readonly code?: string;
    readonly replayIdempotencyKey?: string;
    readonly routeKey: SymmyDurableRouteKey;
  }) => Effect.Effect<ConfiguredRouteContext, SymmyJobStoreError>;
}

export const symmyJobStoreFactory = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): Effect.Effect<SymmyJobStore> =>
  Effect.succeed({
    admit: Effect.fn('SymmyJobStore.admit')(function* admit<R>(
      input: SymmyJobAdmissionRequest,
      admissionInvocationId?: string,
      beforeInsert?: BeforeJobInsert<R>,
    ) {
      if (transaction.scope.tenantId !== scope.tenantId || transaction.scope.legalEntityId !== scope.legalEntityId) {
        return yield* unavailable();
      }

      const fixtureId = input.fixtureId ?? 'INTERNAL_C14';
      const callerIntent = yield* encodeCallerIntent(input, fixtureId);
      const [idempotencyDigest, intentDigest] = yield* Effect.all([hash(input.idempotencyKey), hash(callerIntent)], {
        concurrency: 2,
      });
      const activeRoute = and(
        eq(symmyJobRoutes.active, true),
        eq(symmyJobRoutes.tenantId, scope.tenantId),
        eq(symmyJobRoutes.principalId, scope.principalId),
        scope.legalEntityId === undefined
          ? isNull(symmyJobRoutes.legalEntityId)
          : eq(symmyJobRoutes.legalEntityId, scope.legalEntityId),
        eq(symmyJobRoutes.routeKey, input.routeKey),
        input.code === undefined ? isNull(symmyJobRoutes.routeCode) : eq(symmyJobRoutes.routeCode, input.code),
      );

      const routes = yield* transaction
        .select()
        .from(symmyJobRoutes)
        .where(activeRoute)
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      const [route] = routes;
      if (routes.length !== 1 || route === undefined) {
        return yield* routeDenied();
      }
      yield* lockRoute(transaction, route);
      const template = yield* decodeRouteTemplate(route);
      if (
        (admissionInvocationId !== undefined ||
          Schema.is(SymmyPolicyFixtureRouteKeySchema)(input.routeKey) ||
          readVerifiedGatewayRouteScope(scope) !== undefined) &&
        !exactRouteProofMatches(route, scope, template, idempotencyDigest)
      ) {
        return yield* routeDenied();
      }
      const readAcceptedJob = transaction
        .select({
          ...receiptColumns,
          executionPlan: symmyImportJobs.executionPlan,
          intentDigest: symmyImportJobs.intentDigest,
        })
        .from(symmyImportJobs)
        .where(
          and(
            eq(symmyImportJobs.tenantId, scope.tenantId),
            eq(symmyImportJobs.routeKey, input.routeKey),
            eq(symmyImportJobs.principalId, scope.principalId),
            input.code === undefined ? isNull(symmyImportJobs.routeCode) : eq(symmyImportJobs.routeCode, input.code),
            scope.legalEntityId === undefined
              ? isNull(symmyImportJobs.legalEntityId)
              : eq(symmyImportJobs.legalEntityId, scope.legalEntityId),
            eq(symmyImportJobs.idempotencyDigest, idempotencyDigest),
          ),
        )
        .limit(2)
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap(([existing, duplicate]) => {
            if (duplicate !== undefined) {
              return Effect.fail(unavailable());
            }
            if (existing === undefined) {
              return Effect.succeed(Option.none<SymmyJobAdmissionReceipt>());
            }
            if (existing.intentDigest !== intentDigest) {
              return Effect.fail(new SymmyJobStoreError({ code: 'idempotency_conflict' }));
            }
            return Effect.succeed(
              Option.some({
                executionReady: existing.executionPlan !== null,
                inserted: false,
                jobId: existing.jobId,
                phase: existing.phase,
              }),
            );
          }),
        );
      const accepted = yield* readAcceptedJob;
      if (Option.isSome(accepted)) {
        return accepted.value;
      }
      if (!permitsNewAdmission(route, scope, fixtureId)) {
        return yield* routeDenied();
      }
      const preparedPlan = yield* prepareAdmissionPlan({ scope, transaction }, route, input, template);
      yield* authorizeNewJob(preparedPlan, input.routeKey, admissionInvocationId, beforeInsert);
      // The shared route lock retains the exact enrollment while typed effect bookkeeping is pinned.
      // All inserts, native Action receipt and outbox admission commit in the same Core operation.
      const [inserted] = yield* transaction
        .insert(symmyImportJobs)
        .values({
          admissionInvocationId: admissionInvocationId ?? null,
          executionPlan: preparedPlan,
          fixtureId,
          idempotencyDigest,
          intentDigest,
          legalEntityId: route.legalEntityId,
          lifecyclePolicy: route.lifecyclePolicy,
          mappingVersion: route.mappingVersion,
          phase: 'admitted',
          principalId: route.principalId,
          routeCode: route.routeCode,
          routeId: route.routeId,
          routeKey: route.routeKey,
          routeRevision: route.routeRevision,
          tenantId: route.tenantId,
        })
        .onConflictDoNothing()
        .returning({ ...receiptColumns, executionPlan: symmyImportJobs.executionPlan })
        .pipe(Effect.mapError(unavailable));

      if (inserted !== undefined) {
        if (inserted.executionPlan !== null) {
          if (admissionInvocationId !== undefined) {
            yield* openScopedSourceExecutionFence(transaction, admissionInvocationId, {
              gateId: route.routeId,
              mappingVersion: route.mappingVersion,
              revision: route.routeRevision,
            }).pipe(Effect.mapError(unavailable));
          }
          const plan = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema, { onExcessProperty: 'error' })(
            inserted.executionPlan,
          ).pipe(Effect.mapError(unavailable));
          yield* transaction
            .insert(symmyJobEffects)
            .values(
              plan.items.flatMap(({ effects }) =>
                effects.map((effect) => ({
                  effect,
                  effectId: effect.ref.effectId,
                  effectKey: effect.effectKey,
                  itemId: effect.itemId,
                  jobId: inserted.jobId,
                  state: 'planned' as const,
                  tenantId: scope.tenantId,
                  version: 0,
                })),
              ),
            )
            .pipe(Effect.mapError(unavailable));
        }
        return {
          executionReady: inserted.executionPlan !== null,
          inserted: true,
          jobId: inserted.jobId,
          phase: inserted.phase,
        };
      }

      // A new READ COMMITTED statement observes the winning transaction after an insert conflict.
      return yield* readAcceptedJob.pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.catchTag('NoSuchElementError', routeDenied),
      );
    }),
    admitSync: Effect.fn('SymmyJobStore.admitSync')(function* admitSync(
      input: SymmyJobAdmissionRequest,
      admissionId: string,
    ) {
      if (!isSyncAdmissionRoute(input.routeKey)) {
        return yield* routeDenied();
      }
      const fixtureId = input.fixtureId ?? 'INTERNAL_C14';
      const rows = yield* transaction
        .select()
        .from(symmyJobRoutes)
        .where(
          and(
            eq(symmyJobRoutes.active, true),
            eq(symmyJobRoutes.tenantId, scope.tenantId),
            eq(symmyJobRoutes.principalId, scope.principalId),
            eq(symmyJobRoutes.routeKey, input.routeKey),
            isNull(symmyJobRoutes.routeCode),
            scope.legalEntityId === undefined
              ? isNull(symmyJobRoutes.legalEntityId)
              : eq(symmyJobRoutes.legalEntityId, scope.legalEntityId),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      const [route] = rows;
      if (rows.length !== 1 || route === undefined) {
        return yield* routeDenied();
      }
      yield* lockRoute(transaction, route);
      const [template, callerIntent] = yield* Effect.all(
        [decodeRouteTemplate(route), encodeCallerIntent(input, fixtureId)],
        { concurrency: 2 },
      );
      const [keyDigest, intentDigest] = yield* Effect.all([hash(input.idempotencyKey), hash(callerIntent)], {
        concurrency: 2,
      });
      if (!exactRouteProofMatches(route, scope, template, keyDigest)) {
        return yield* routeDenied();
      }
      const existingWhere = syncAdmissionKey(scope, input.routeKey, keyDigest);
      const [existing, duplicate] = yield* transaction
        .select()
        .from(symmySyncAdmissions)
        .where(existingWhere)
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      if (duplicate !== undefined) {
        return yield* unavailable();
      }
      if (existing !== undefined) {
        yield* verifySyncReplay(existing, intentDigest);
        return yield* syncAdmissionReceipt(transaction, existing, { invocationId: admissionId, replayed: true });
      }
      const plan = yield* prepareSyncPlan(route, input, scope, template);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema))(plan).pipe(
        Effect.mapError(unavailable),
      );
      const [row] = yield* transaction
        .select({
          plan: sql<SymmyPinnedJobPlan>`symmy_integration.pin_symmy_fixture_plan(${encoded}::jsonb,${symmyJobRoutes.tenantId},${symmyJobRoutes.routeId},${symmyJobRoutes.routeRevision},${symmyJobRoutes.mappingVersion})`.as(
            'plan',
          ),
        })
        .from(symmyJobRoutes)
        .where(and(eq(symmyJobRoutes.tenantId, scope.tenantId), eq(symmyJobRoutes.routeId, route.routeId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      const pinned = materializePinnedPlan(
        yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)(row.plan).pipe(Effect.mapError(unavailable)),
      );
      const authContextRef = yield* registeredAdmissionAuthContextRef(symmyExecutionRegistration, admissionId).pipe(
        Effect.mapError(unavailable),
      );
      const pinnedItems = yield* Effect.forEach(
        pinned.items,
        (item) => pinSyncItem({ authContextRef, scope, transaction }, item),
        { concurrency: 1 },
      );
      const savedPlan = yield* Schema.decodeUnknownEffect(Schema.toType(SymmyPinnedJobPlanSchema))({
        ...pinned,
        items: pinnedItems,
      }).pipe(Effect.mapError(unavailable));
      const [inserted] = yield* transaction
        .insert(symmySyncAdmissions)
        .values({
          admissionId,
          executionPlan: savedPlan,
          idempotencyDigest: keyDigest,
          intentDigest,
          legalEntityId: scope.legalEntityId ?? null,
          lifecyclePolicy: route.lifecyclePolicy,
          mappingVersion: route.mappingVersion,
          principalId: scope.principalId,
          routeId: route.routeId,
          routeKey: input.routeKey,
          routeRevision: route.routeRevision,
          tenantId: scope.tenantId,
        })
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (inserted !== undefined) {
        yield* openScopedSourceExecutionFence(transaction, admissionId, {
          gateId: route.routeId,
          mappingVersion: route.mappingVersion,
          revision: route.routeRevision,
        }).pipe(Effect.mapError(unavailable));
        return yield* syncAdmissionReceipt(transaction, inserted, { invocationId: admissionId, replayed: false });
      }
      const [winner, competingReceipt] = yield* transaction
        .select()
        .from(symmySyncAdmissions)
        .where(existingWhere)
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      if (winner === undefined || competingReceipt !== undefined) {
        return yield* unavailable();
      }
      yield* verifySyncReplay(winner, intentDigest);
      return yield* syncAdmissionReceipt(transaction, winner, { invocationId: admissionId, replayed: true });
    }),
    poll: Effect.fn('SymmyJobStore.poll')(function* poll(jobId: string) {
      if (transaction.scope.tenantId !== scope.tenantId || transaction.scope.legalEntityId !== scope.legalEntityId) {
        return yield* unavailable();
      }
      const [job] = yield* transaction
        .select({ ...receiptColumns, executionPlan: symmyImportJobs.executionPlan })
        .from(symmyImportJobs)
        .where(
          and(
            eq(symmyImportJobs.tenantId, scope.tenantId),
            eq(symmyImportJobs.principalId, scope.principalId),
            scope.legalEntityId === undefined ? undefined : eq(symmyImportJobs.legalEntityId, scope.legalEntityId),
            eq(symmyImportJobs.jobId, jobId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (job === undefined) {
        return Option.none();
      }
      if (job.executionPlan === null) {
        return yield* Schema.decodeUnknownEffect(SymmyJobExecutionProjectionSchema)({
          items: [],
          jobId: job.jobId,
          phase: 'blocked',
        }).pipe(Effect.map(Option.some), Effect.mapError(unavailable));
      }
      const execution = yield* symmyJobExecutionStore(transaction).load(jobId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(execution)) {
        return yield* unavailable();
      }
      return yield* projectSymmyExecutionJob(execution.value).pipe(
        Effect.map(Option.some),
        Effect.mapError(unavailable),
      );
    }),
    readSyncAdmission: Effect.fn('SymmyJobStore.readSyncAdmission')(function* readSyncAdmission(admissionId: string) {
      if (transaction.scope.tenantId !== scope.tenantId || transaction.scope.legalEntityId !== scope.legalEntityId) {
        return yield* unavailable();
      }
      const [entry] = yield* transaction
        .select({ admission: symmySyncAdmissions, route: symmyJobRoutes })
        .from(symmySyncAdmissionAttempts)
        .innerJoin(
          symmySyncAdmissions,
          and(
            eq(symmySyncAdmissions.admissionId, symmySyncAdmissionAttempts.admissionId),
            eq(symmySyncAdmissions.tenantId, symmySyncAdmissionAttempts.tenantId),
          ),
        )
        .innerJoin(
          symmyJobRoutes,
          and(
            eq(symmyJobRoutes.tenantId, symmySyncAdmissions.tenantId),
            eq(symmyJobRoutes.routeKey, symmySyncAdmissions.routeKey),
            eq(symmyJobRoutes.principalId, symmySyncAdmissions.principalId),
          ),
        )
        .where(
          and(
            eq(symmySyncAdmissionAttempts.invocationId, admissionId),
            eq(symmySyncAdmissions.tenantId, scope.tenantId),
            eq(symmySyncAdmissions.principalId, scope.principalId),
            eq(symmyJobRoutes.active, true),
            isNull(symmySyncAdmissions.retentionReceipt),
            scope.legalEntityId === undefined
              ? isNull(symmySyncAdmissions.legalEntityId)
              : eq(symmySyncAdmissions.legalEntityId, scope.legalEntityId),
            scope.legalEntityId === undefined
              ? isNull(symmyJobRoutes.legalEntityId)
              : eq(symmyJobRoutes.legalEntityId, scope.legalEntityId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (entry === undefined) {
        return yield* routeDenied();
      }
      yield* lockRoute(transaction, entry.route);
      const template = yield* decodeRouteTemplate(entry.route);
      if (!exactRouteProofMatches(entry.route, scope, template, entry.admission.idempotencyDigest)) {
        return yield* routeDenied();
      }
      // Reading the immutable original receipt does not require the writer to remain enrolled.
      // The issuer independently checks fresh WRITE authority for Actions and READ authority for recovery.
      return yield* syncReceipt(transaction, entry.admission, true);
    }),
    routeContext: Effect.fn('SymmyJobStore.routeContext')(function* routeContext(input: {
      readonly code?: string;
      readonly replayIdempotencyKey?: string;
      readonly routeKey: SymmyDurableRouteKey;
    }) {
      const decoded =
        input.code === undefined
          ? undefined
          : yield* decodeSymmySourceSelector(input.code).pipe(Effect.mapError(routeDenied));
      const selector = configuredRouteSelector(decoded, scope.tenantId);
      const rows = yield* transaction
        .select()
        .from(symmyJobRoutes)
        .where(
          and(
            eq(symmyJobRoutes.active, true),
            eq(symmyJobRoutes.tenantId, scope.tenantId),
            eq(symmyJobRoutes.principalId, scope.principalId),
            eq(symmyJobRoutes.routeKey, input.routeKey),
            selector,
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      const checked = yield* Effect.forEach(rows, (row) => qualifyConfiguredRoute({ decoded, scope }, row), {
        concurrency: 1,
      });
      const matches = checked.flatMap(Option.toArray);
      const [match] = matches;
      if (matches.length === 1 && match !== undefined) {
        return match;
      }
      if (matches.length > 1 || input.replayIdempotencyKey === undefined) {
        return yield* routeDenied();
      }
      const digest = yield* hash(input.replayIdempotencyKey);
      if (isSyncAdmissionRoute(input.routeKey)) {
        const [row, competingRoute] = rows;
        if (row === undefined || competingRoute !== undefined) {
          return yield* routeDenied();
        }
        const retained = yield* qualifyRetainedSyncRoute(transaction, row, digest);
        return yield* Effect.fromOption(retained).pipe(Effect.mapError(routeDenied));
      }
      const retained = yield* qualifyRetainedJobRoute(transaction, scope, input.routeKey, decoded, digest);
      return yield* Effect.fromOption(retained).pipe(Effect.mapError(routeDenied));
    }),
  });
