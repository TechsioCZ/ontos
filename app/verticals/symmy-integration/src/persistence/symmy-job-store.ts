import { defineScopedRoutine, registeredAdmissionAuthContextRef } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { readVerifiedGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import {
  openScopedSourceExecutionFence,
  readScopedOriginalActionInvocation,
  readScopedSystemWorkloadEnrollment,
  requireScopedSourceExecutionFenceOpen,
} from '@app/core-runtime/access/enforcement';
import { and, arrayContains, eq, isNull, sql } from 'drizzle-orm';
import { Array as EffectArray, Config, Duration, Effect, Match, Option, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { SymmyFixtureExecutionPlanSchema, SymmyPinnedJobPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type {
  SymmyJobExecutionProjectionSchema,
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
import { SymmyCatalogPricingInventoryIntentSchema } from '../../shared/domain/symmy-catalog-pricing-inventory-intents.ts';
import { decodeSymmySourceSelector, verifySymmySourceSelector } from '../../shared/domain/symmy-source-selector.ts';
import { AdmitSymmySyncResultSchema } from '../../shared/actions/admit-symmy-sync.ts';
import type { SymmyDecodedSourceSelector } from '../../shared/domain/symmy-source-selector.ts';
import {
  mapSymmyPolicyFixtureIntent,
  SymmyPolicyFixtureIntentSchema,
  SymmyPolicyFixtureRouteKeySchema,
} from '../../shared/domain/symmy-policy-fixture-intents.ts';
import { symmyExecutionRegistration } from '../services/symmy-worker-identity.service.ts';

export class SymmyJobStoreError extends Schema.TaggedError<SymmyJobStoreError>()('SymmyJobStoreError', {
  code: Schema.Literals(['route_denied', 'idempotency_conflict', 'unavailable']),
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
  const sources = template.items.map(({ source }) => source);
  const operations = template.items.flatMap(({ effects }) => effects.map(({ operation }) => operation));
  return !plan.items.some(
    ({ effects, source }) =>
      !sources.some(
        (allowed) =>
          allowed.issuerId === source.issuerId &&
          allowed.sourceNamespace === source.sourceNamespace &&
          allowed.entityKind === source.entityKind,
      ) ||
      effects.some(
        ({ intent, operation, originalTarget }) =>
          intent === undefined ||
          !operations.some(
            (allowed) =>
              allowed.moduleId === operation.moduleId &&
              allowed.entrypointKey === operation.entrypointKey &&
              allowed.schemaVersion === operation.schemaVersion,
          ) ||
          (originalTarget !== undefined &&
            (originalTarget.tenantId !== scope.tenantId || originalTarget.moduleId !== operation.moduleId)),
      ),
  );
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

const policyFixtureAdmissionAllowed = (
  input: SymmyJobAdmissionRequest,
  route: typeof symmyJobRoutes.$inferSelect,
  scope: OperationalScope,
): boolean => {
  const proof = readVerifiedGatewayRouteScope(scope);
  return (
    input.fixtureId !== undefined &&
    input.plan === undefined &&
    route.fixturePlan !== null &&
    proof?.routeKey === route.routeKey &&
    proof.routeId === route.routeId &&
    proof.routeRevision === route.routeRevision &&
    proof.sourceRouteId === route.routeId &&
    proof.sourceRouteRevision === route.routeRevision
  );
};

const selectedPlanMatches = (
  input: SymmyJobAdmissionRequest,
  template: SymmyFixtureExecutionPlan,
  tenantId: string,
): boolean => {
  if (input.plan === undefined || input.code === undefined) {
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

const prepareAdmissionPlan = Effect.fn('SymmyJobStore.prepareAdmissionPlan')(function* prepareAdmissionPlan(
  context: { scope: OperationalScope; transaction: ScopedTransactionExecutor },
  route: typeof symmyJobRoutes.$inferSelect,
  input: SymmyJobAdmissionRequest,
) {
  const { scope, transaction } = context;
  const isPolicyFixture = Schema.is(SymmyPolicyFixtureRouteKeySchema)(input.routeKey);
  if (isPolicyFixture && !policyFixtureAdmissionAllowed(input, route, scope)) {
    return yield* routeDenied();
  }
  let preparedPlan: SymmyPinnedJobPlan | null = null;
  if (route.fixturePlan !== null) {
    const template = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(route.fixturePlan).pipe(
      Effect.mapError(unavailable),
    );
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
    const executionPlanJson = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema))(
      configuredPlan(input.plan ?? template, template),
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
  yield* requireScopedSourceExecutionFenceOpen(transaction, saved.admissionId).pipe(Effect.mapError(unavailable));
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

interface SyncPrincipalFacts {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}
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

const configuredRouteSelector = (decoded: SymmyDecodedSourceSelector | undefined, tenantId: string) => {
  if (decoded === undefined) {
    return isNull(symmyJobRoutes.routeCode);
  }
  return Match.value(decoded).pipe(
    Match.tag('Legacy', ({ code }) => eq(symmyJobRoutes.routeCode, code)),
    Match.tag('Qualified', ({ code, targetResourceId }) =>
      and(
        sql`${symmyJobRoutes.fixturePlan} #>> '{selector,target,resourceId}' = ${targetResourceId}`,
        sql`symmy_integration.symmy_source_selector_code(
          ${tenantId}::text,
          ${symmyJobRoutes.fixturePlan} #>> '{selector,source,issuerId}',
          ${symmyJobRoutes.fixturePlan} #>> '{selector,source,sourceNamespace}',
          ${symmyJobRoutes.fixturePlan} #>> '{selector,source,route,integrationRouteId}',
          ${symmyJobRoutes.fixturePlan} #>> '{selector,kind}',
          ${symmyJobRoutes.fixturePlan} #>> '{selector,source,sourceRecordId}',
          ${symmyJobRoutes.fixturePlan} #>> '{selector,target,resourceId}'
        ) = ${code}`,
      ),
    ),
    Match.exhaustive,
  );
};
const qualifiedSelectorMatches = Effect.fn('SymmyJobStore.qualifiedSelectorMatches')(function* qualifiedSelectorMatches(
  decoded: Extract<SymmyDecodedSourceSelector, { _tag: 'Qualified' }>,
  plan: SymmyFixtureExecutionPlan,
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
    sourceMappingVersion: plan.sourceMappingVersion ?? row.mappingVersion,
    sourceNamespace: first.source.sourceNamespace,
    sourceRouteId: plan.sourceRouteId ?? row.routeId,
    sourceRouteRevision: plan.sourceRouteRevision ?? row.routeRevision,
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

const prepareSyncPlan = Effect.fn('SymmyJobStore.prepareSyncPlan')(function* prepareSyncPlan(
  route: typeof symmyJobRoutes.$inferSelect,
  input: SymmyJobAdmissionRequest,
  scope: OperationalScope,
) {
  const template = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(route.fixturePlan).pipe(
    Effect.mapError(unavailable),
  );
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

type SymmyJobPollResult =
  | typeof SymmyJobExecutionProjectionSchema.Type
  | {
      readonly jobId: string;
      readonly phase: 'admitted';
    };

interface SymmyJobStore {
  readonly admit: (
    input: SymmyJobAdmissionRequest,
    admissionInvocationId?: string,
  ) => Effect.Effect<SymmyJobAdmissionReceipt, SymmyJobStoreError>;
  readonly admitSync: (
    input: SymmyJobAdmissionRequest,
    admissionId: string,
  ) => Effect.Effect<SymmySyncAdmissionReceipt, SymmyJobStoreError>;
  readonly poll: (jobId: string) => Effect.Effect<Option.Option<SymmyJobPollResult>, SymmyJobStoreError>;
  readonly readSyncAdmission: (admissionId: string) => Effect.Effect<SymmySyncAdmissionReceipt, SymmyJobStoreError>;
  readonly routeContext: (input: {
    readonly code?: string;
    readonly routeKey: SymmyDurableRouteKey;
  }) => Effect.Effect<ConfiguredRouteContext, SymmyJobStoreError>;
}

export const symmyJobStoreFactory = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): Effect.Effect<SymmyJobStore> =>
  Effect.succeed({
    admit: Effect.fn('SymmyJobStore.admit')(function* admit(
      input: SymmyJobAdmissionRequest,
      admissionInvocationId?: string,
    ) {
      if (transaction.scope.tenantId !== scope.tenantId || transaction.scope.legalEntityId !== scope.legalEntityId) {
        return yield* unavailable();
      }

      const fixtureId = input.fixtureId ?? 'INTERNAL_C14';
      const intent = yield* encodeCallerIntent(input, fixtureId);
      const [idempotencyDigest, intentDigest] = yield* Effect.all([hash(input.idempotencyKey), hash(intent)], {
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
        .where(and(activeRoute, arrayContains(symmyJobRoutes.fixtureIds, [fixtureId])))
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      const [route] = routes;
      if (routes.length !== 1 || route === undefined) {
        return yield* routeDenied();
      }
      yield* lockRoute(transaction, route);
      const preparedPlan = yield* prepareAdmissionPlan({ scope, transaction }, route, input);
      if (
        preparedPlan !== null &&
        preparedPlan.items.some(({ effects }) =>
          effects.some(({ intent: effectIntent }) => effectIntent !== undefined),
        ) &&
        admissionInvocationId === undefined
      ) {
        return yield* routeDenied();
      }
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
        .onConflictDoNothing({
          target: [
            symmyImportJobs.tenantId,
            symmyImportJobs.routeId,
            symmyImportJobs.routeKey,
            symmyImportJobs.idempotencyDigest,
          ],
        })
        .returning({ ...receiptColumns, executionPlan: symmyImportJobs.executionPlan })
        .pipe(Effect.mapError(unavailable));

      if (inserted !== undefined) {
        if (inserted.executionPlan !== null) {
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

      // After an insert conflict, a new READ COMMITTED statement observes the winning transaction.
      // Fresh config versions and fixture allowlist changes do not rewrite the accepted pin.
      const [existing] = yield* transaction
        .select({
          ...receiptColumns,
          executionPlan: symmyImportJobs.executionPlan,
          intentDigest: symmyImportJobs.intentDigest,
        })
        .from(symmyImportJobs)
        .innerJoin(
          symmyJobRoutes,
          and(
            eq(symmyJobRoutes.tenantId, symmyImportJobs.tenantId),
            eq(symmyJobRoutes.routeId, symmyImportJobs.routeId),
          ),
        )
        .where(
          and(
            activeRoute,
            eq(symmyImportJobs.routeKey, input.routeKey),
            eq(symmyImportJobs.principalId, scope.principalId),
            scope.legalEntityId === undefined
              ? isNull(symmyImportJobs.legalEntityId)
              : eq(symmyImportJobs.legalEntityId, scope.legalEntityId),
            eq(symmyImportJobs.idempotencyDigest, idempotencyDigest),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (existing === undefined) {
        return yield* routeDenied();
      }
      if (existing.intentDigest !== intentDigest) {
        return yield* new SymmyJobStoreError({ code: 'idempotency_conflict' });
      }
      return {
        executionReady: existing.executionPlan !== null,
        inserted: false,
        jobId: existing.jobId,
        phase: existing.phase,
      };
    }),
    admitSync: Effect.fn('SymmyJobStore.admitSync')(function* admitSync(
      input: SymmyJobAdmissionRequest,
      admissionId: string,
    ) {
      if (input.routeKey !== 'customerGroupsBatch' && input.routeKey !== 'inventoryStockBatch') {
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
            arrayContains(symmyJobRoutes.fixtureIds, [fixtureId]),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      const [route] = rows;
      if (rows.length !== 1 || route === undefined || route.fixturePlan === null) {
        return yield* routeDenied();
      }
      yield* lockRoute(transaction, route);
      const plan = yield* prepareSyncPlan(route, input, scope);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema))(plan).pipe(
        Effect.mapError(unavailable),
      );
      const callerIntent = yield* encodeCallerIntent(input, fixtureId);
      const [keyDigest, intentDigest] = yield* Effect.all([hash(input.idempotencyKey), hash(callerIntent)], {
        concurrency: 2,
      });
      const existingWhere = and(
        eq(symmySyncAdmissions.tenantId, scope.tenantId),
        eq(symmySyncAdmissions.routeId, route.routeId),
        eq(symmySyncAdmissions.idempotencyDigest, keyDigest),
        eq(symmySyncAdmissions.principalId, scope.principalId),
      );
      const [existing] = yield* transaction
        .select()
        .from(symmySyncAdmissions)
        .where(existingWhere)
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (existing !== undefined) {
        if (existing.retentionReceipt !== null) {
          return yield* routeDenied();
        }
        if (existing.intentDigest !== intentDigest) {
          return yield* new SymmyJobStoreError({ code: 'idempotency_conflict' });
        }
        return yield* syncAdmissionReceipt(transaction, existing, { invocationId: admissionId, replayed: true });
      }
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
          routeRevision: route.routeRevision,
          tenantId: scope.tenantId,
        })
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (inserted !== undefined) {
        yield* openScopedSourceExecutionFence(transaction, admissionId).pipe(Effect.mapError(unavailable));
        return yield* syncAdmissionReceipt(transaction, inserted, { invocationId: admissionId, replayed: false });
      }
      const [winner] = yield* transaction
        .select()
        .from(symmySyncAdmissions)
        .where(existingWhere)
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (winner === undefined) {
        return yield* unavailable();
      }
      if (winner.intentDigest !== intentDigest) {
        return yield* new SymmyJobStoreError({ code: 'idempotency_conflict' });
      }
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
        return Option.some({ jobId: job.jobId, phase: job.phase });
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
            eq(symmyJobRoutes.routeId, symmySyncAdmissions.routeId),
            eq(symmyJobRoutes.principalId, symmySyncAdmissions.principalId),
            eq(symmyJobRoutes.routeRevision, symmySyncAdmissions.routeRevision),
            eq(symmyJobRoutes.mappingVersion, symmySyncAdmissions.mappingVersion),
            eq(symmyJobRoutes.lifecyclePolicy, symmySyncAdmissions.lifecyclePolicy),
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
      yield* requireLifecyclePolicy(entry.route, true);
      // Reading the immutable original receipt does not require the writer to remain enrolled.
      // The issuer independently checks fresh WRITE authority for Actions and READ authority for recovery.
      return yield* syncReceipt(transaction, entry.admission, true);
    }),
    routeContext: Effect.fn('SymmyJobStore.routeContext')(function* routeContext(input: {
      readonly code?: string;
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
      if (matches.length !== 1 || match === undefined) {
        return yield* routeDenied();
      }
      return match;
    }),
  });
