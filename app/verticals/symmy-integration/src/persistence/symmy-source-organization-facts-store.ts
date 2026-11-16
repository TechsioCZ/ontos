import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import {
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  readVerifiedGatewayOrganizationGovernanceRead,
} from '@app/core-runtime';
import {
  computeActionRequestHash,
  readScopedOriginalActionInvocation,
  readScopedSourceAdmissionEnrollment,
  readScopedSourceExecutionFence,
} from '@app/core-runtime/access/enforcement';
import { readVerifiedGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  organizationBusinessRecordInputDigest,
  organizationBusinessSourceInputDigest,
} from '@app/party-registry/apis/organization-record-facts';
import {
  createPartyRequestIdentity,
  matchPartyRequestIdentity,
  counterpartyCustomerOnboardRequestIdentity,
} from '@app/party-registry/api/native-action-request-identity';
import { createCounterpartyPurchasingProfileRequestIdentity } from '@app/commerce-customer-context/domain/native-action-request-identity';
import {
  fingerprintOrganizationProfileSourceCreate,
  ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { Effect, Match, Option, Schema } from 'effect';
import {
  SymmySourceOrganizationFactsCurrentSchema,
  SymmySourceOrganizationFactsMaterializedSchema,
  SymmySourceOrganizationFactsResponseSchema,
  SymmySourceOrganizationExecutionRefSchema,
} from '../../shared/apis/symmy-source-organization-facts.ts';
import type {
  SymmySourceOrganizationFactsRequest,
  SymmySourceOrganizationFactsResponse,
} from '../../shared/apis/symmy-source-organization-facts.ts';
import {
  SymmyExecutionEffectStateSchema,
  SymmyPinnedEffectSchema,
  SymmyPinnedJobPlanSchema,
} from '../../shared/domain/symmy-job-execution.ts';
import { projectSymmyOrganizationAcceptedEffect } from '../../shared/domain/symmy-source-organization-projections.ts';
import type { SymmyAcceptedOrganizationProjection } from '../../shared/domain/symmy-source-organization-projections.ts';
import type { SymmyPinnedEffect } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyPartyCommerceOwnerReceiptSchema } from '../../shared/domain/symmy-party-commerce-intents.ts';
import {
  SymmyPartyCommerceIntentSchema,
  resolveSymmyCounterpartyOnboardParty,
  resolveSymmyCounterpartyProfileCounterparty,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import {
  symmyImportJobs,
  symmySyncAdmissions,
  symmySyncAdmissionAttempts,
  symmyJobRoutes,
  symmyJobEffects,
} from '../db/schema.ts';

const createPartyActionKey = 'party.registry.create-party';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'The retained organization source facts are unavailable.',
    }),
    'cause',
    { enumerable: false, value: cause },
  );
const forbidden = () =>
  new ReadPermissionDenied({
    code: 'read_permission_denied',
    reason: 'This source fact purpose is not admitted by the verified caller.',
  });
const notCurrent = { outcome: 'NOT_CURRENT' } as const;
const admissionIdSchema = SymmySourceOrganizationFactsCurrentSchema.fields.acceptedAdmissionInvocationId;
const rowSchema = Schema.Struct({
  acceptedAdmissionInvocationId: Schema.OptionFromNullOr(admissionIdSchema),
  currentActive: Schema.Boolean,
  currentLegalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
  currentMappingVersion: Schema.String,
  currentOperatorPrincipalId: PrincipalIdSchema,
  currentRouteRevision: Schema.String,
  execution: SymmySourceOrganizationExecutionRefSchema,
  executionPlan: Schema.OptionFromNullOr(SymmyPinnedJobPlanSchema),
  intentDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  legalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
  mappingVersion: Schema.String,
  operatorPrincipalId: PrincipalIdSchema,
  retentionPurged: Schema.Boolean,
  routeId: SymmySourceOrganizationFactsCurrentSchema.fields.enrollmentRouteId,
  routeRevision: Schema.String,
});

/** The whole native payload is validated by Party; no sanitizer can turn personal input into business evidence. */
type SymmyOrganizationSourceProjection = Effect.Success<ReturnType<typeof organizationBusinessSourceInputDigest>>;

export const symmyOrganizationProjectionForEffect: (
  effect: SymmyPinnedEffect,
) => Effect.Effect<Option.Option<SymmyOrganizationSourceProjection>> = Effect.fn(
  'SymmyOrganizationSource.projectNativeInput',
)(function* project(effect: SymmyPinnedEffect) {
  const intent = Schema.decodeUnknownOption(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(
    effect.intent,
  );
  if (
    Option.isNone(intent) ||
    effect.ref.operation.moduleId !== 'party.registry' ||
    effect.ref.operation.schemaVersion !== '1'
  ) {
    return Option.none();
  }
  const input = Match.value(intent.value).pipe(
    Match.tag('PartyCreate', (value) =>
      effect.ref.operation.entrypointKey === createPartyActionKey
        ? Option.some({ operation: 'CREATE' as const, payload: value.payload })
        : Option.none(),
    ),
    Match.tag('PartyMatch', (value) =>
      effect.ref.operation.entrypointKey === 'party.registry.match-party'
        ? Option.some({ operation: 'MATCH' as const, payload: value.payload })
        : Option.none(),
    ),
    Match.orElse(() => Option.none()),
  );
  if (Option.isNone(input)) {
    return Option.none();
  }
  const projection = yield* organizationBusinessSourceInputDigest(input.value).pipe(
    Effect.map(Option.some),
    Effect.catchTag('SchemaError', () => Effect.succeed(Option.none())),
  );
  if (Option.isNone(projection)) {
    return Option.none();
  }
  const { sourceReference } = projection.value;
  const { record } = effect.ref.occurrence;
  return sourceReference.source.issuer === record.issuerId &&
    sourceReference.source.namespace === record.sourceNamespace &&
    sourceReference.source.recordType === record.entityKind &&
    sourceReference.source.routeRef === record.route.integrationRouteId &&
    sourceReference.recordId === record.sourceRecordId &&
    sourceReference.occurrenceId === effect.ref.occurrence.occurrenceId
    ? projection
    : Option.none();
});

export interface SymmySourceOrganizationFactsServices {
  readonly readSourceOrganizationFacts: (
    input: SymmySourceOrganizationFactsRequest,
  ) => Effect.Effect<SymmySourceOrganizationFactsResponse, ReadHandlerUnavailable | ReadPermissionDenied>;
}
const sameSource = (
  left: (typeof SymmySourceOrganizationFactsCurrentSchema)['fields']['sourceReference']['Type'],
  right: (typeof SymmySourceOrganizationFactsCurrentSchema)['fields']['sourceReference']['Type'],
) => Schema.toEquivalence(SymmySourceOrganizationFactsCurrentSchema.fields.sourceReference)(left, right);

type StoredSourceRow = typeof rowSchema.Type;
type VerifiedWorkload = NonNullable<ReturnType<typeof readVerifiedGatewayWorkload>>;
const processingIdentityValid = (authMethod: string, workload: VerifiedWorkload | undefined) =>
  authMethod === 'system' &&
  workload !== undefined &&
  workload.workloadKey === 'integration.symmy.source-organization-facts.read' &&
  workload.entrypointKey === 'integration.symmy.api.symmy-source-organization-facts' &&
  workload.declarationKey === 'integration.symmy.symmy-source-organization-facts.read';
const processingAnchorCurrent = (
  workload: VerifiedWorkload,
  input: Extract<SymmySourceOrganizationFactsRequest, { readonly purpose: 'PROCESSING' }>,
) =>
  workload.recovery === undefined &&
  workload.sourceMode !== 'historical_delivery' &&
  workload.originalWorkloadKey === 'integration.symmy-admit' &&
  workload.admissionInvocationId === input.originalAdmissionInvocationId &&
  (workload.sourceMode !== 'worker' ||
    (workload.workerModuleKey === 'integration.symmy' && workload.workerKey === 'integration.symmy.execute-symmy-job'));
/** A verified governance carrier never becomes authority for the machine-processing purpose. */
export const symmyOrganizationSourceCallerDecision = (
  scope: OperationalScope,
  input: SymmySourceOrganizationFactsRequest,
) => {
  const governance = readVerifiedGatewayOrganizationGovernanceRead(scope);
  if (governance !== undefined) {
    return input.purpose === 'GOVERNANCE' ? 'current' : 'forbidden';
  }
  if (input.purpose === 'GOVERNANCE') {
    return 'forbidden';
  }
  const workload = readVerifiedGatewayWorkload(scope);
  if (!processingIdentityValid(scope.authMethod, workload) || workload === undefined) {
    return 'forbidden';
  }
  return processingAnchorCurrent(workload, input) ? 'current' : 'not_current';
};
const rowIsCurrent = (row: StoredSourceRow, legalEntityId: string | undefined) =>
  !row.retentionPurged &&
  Option.isSome(row.executionPlan) &&
  Option.isSome(row.acceptedAdmissionInvocationId) &&
  row.currentActive &&
  row.operatorPrincipalId === row.currentOperatorPrincipalId &&
  row.mappingVersion === row.currentMappingVersion &&
  row.routeRevision === row.currentRouteRevision &&
  Option.getOrUndefined(row.legalEntityId) === legalEntityId &&
  Option.getOrUndefined(row.currentLegalEntityId) === legalEntityId;
const effectMatchesSelector = (effect: SymmyPinnedEffect, input: SymmySourceOrganizationFactsRequest) => {
  if (input.purpose === 'PROCESSING') {
    return effect.ref.effectId === input.effectId;
  }
  const { occurrenceId, record } = effect.ref.occurrence;
  return (
    effect.effectKey === input.effectKey &&
    sameSource(
      {
        occurrenceId,
        recordId: record.sourceRecordId,
        source: {
          issuer: record.issuerId,
          namespace: record.sourceNamespace,
          recordType: record.entityKind,
          routeRef: record.route.integrationRouteId,
        },
      },
      input.sourceReference,
    )
  );
};
const selectNamedEffect = (plan: typeof SymmyPinnedJobPlanSchema.Type, input: SymmySourceOrganizationFactsRequest) => {
  const matches: SymmyPinnedEffect[] = [];
  for (const item of plan.items) {
    for (const effect of item.effects) {
      if (effectMatchesSelector(effect, input)) {
        matches.push(effect);
      }
    }
  }
  return matches.length === 1 ? Option.fromUndefinedOr(matches[0]) : Option.none();
};

type RetainedEffect = typeof SymmyExecutionEffectStateSchema.Type;
type SourceProjection = SymmyAcceptedOrganizationProjection;
type NativeIntent = typeof SymmyPartyCommerceIntentSchema.Type;
type NativeOnboard = Extract<NativeIntent, { readonly _tag: 'OnboardCounterpartyCustomer' }>;
type OwnerReceipt = typeof SymmyPartyCommerceOwnerReceiptSchema.Type;
type PartyReceipt = Extract<OwnerReceipt, { readonly _tag: 'PartyCreated' | 'PartyMatched' }>;
type OnboardReceipt = Extract<OwnerReceipt, { readonly _tag: 'CounterpartyCustomerOnboarded' }>;
type Materialization = typeof SymmySourceOrganizationFactsMaterializedSchema.fields.materialization.Type;
interface MaterializationInput {
  readonly effect: SymmyPinnedEffect;
  readonly legalEntityId: string;
  readonly originalAdmissionInvocationId: string;
  readonly plan: typeof SymmyPinnedJobPlanSchema.Type;
  readonly projection: SourceProjection;
  readonly states: readonly RetainedEffect[];
}
interface RetainedMaterializationContext extends MaterializationInput {
  readonly parents: readonly RetainedEffect[];
  readonly party: PartyReceipt;
  readonly references: Materialization['parents'];
  readonly selected: RetainedEffect;
}
const sameEffect = Schema.toEquivalence(SymmyPinnedEffectSchema);
const sameIntent = Schema.toEquivalence(SymmyPartyCommerceIntentSchema);
const exactState = (states: readonly RetainedEffect[], effect: SymmyPinnedEffect) => {
  const found = states.filter((state) => state.effect.ref.effectId === effect.ref.effectId);
  const [state] = found;
  return found.length === 1 && state !== undefined && sameEffect(state.effect, effect)
    ? Option.some(state)
    : Option.none<RetainedEffect>();
};
const effectForName = (
  plan: typeof SymmyPinnedJobPlanSchema.Type,
  reference: { readonly effectKey: string; readonly itemKey: string },
) => {
  const found = plan.items.flatMap((item) =>
    item.itemKey === reference.itemKey ? item.effects.filter((effect) => effect.effectKey === reference.effectKey) : [],
  );
  return found.length === 1 ? Option.fromUndefinedOr(found[0]) : Option.none<SymmyPinnedEffect>();
};
const hasNativeIdentity = (state: RetainedEffect) =>
  Option.isSome(state.ownerExecutorPrincipalId ?? Option.none()) &&
  Option.isSome(state.ownerRequestHash ?? Option.none()) &&
  Option.isSome(state.ownerAuthContextRef ?? Option.none());
const successfulParent = (state: RetainedEffect) =>
  state.state === 'settled' &&
  hasNativeIdentity(state) &&
  Option.isSome(state.ownerInvocationId ?? Option.none()) &&
  Option.isSome(state.ownerReceipt ?? Option.none()) &&
  Option.isSome(state.outcome) &&
  ['accepted_change', 'accepted_no_change', 'duplicate'].includes(state.outcome.value.status) &&
  'effectId' in state.outcome.value &&
  state.outcome.value.effectId === state.effect.ref.effectId &&
  state.outcome.value.owner === state.effect.ref.operation.moduleId;
const materializedEffect = (state: RetainedEffect) => {
  const resolved = Option.getOrUndefined(state.resolvedEffect ?? Option.none());
  return resolved?.intent !== undefined && sameEffect({ ...state.effect, intent: resolved.intent }, resolved)
    ? Option.some(resolved)
    : Option.none<SymmyPinnedEffect>();
};
const retainedPartyReceipt = (state: RetainedEffect, tenantId: string): Option.Option<PartyReceipt> => {
  const receipt = Option.getOrUndefined(state.ownerReceipt ?? Option.none());
  if (!successfulParent(state) || receipt === undefined) {
    return Option.none();
  }
  return Match.value(receipt).pipe(
    Match.tag('PartyCreated', (value) =>
      state.effect.ref.operation.entrypointKey === createPartyActionKey && value.partyRef.tenantId === tenantId
        ? Option.some(value)
        : Option.none<PartyReceipt>(),
    ),
    Match.tag('PartyMatched', (value) =>
      [createPartyActionKey, 'party.registry.match-party'].includes(state.effect.ref.operation.entrypointKey) &&
      value.partyRef.tenantId === tenantId
        ? Option.some(value)
        : Option.none<PartyReceipt>(),
    ),
    Match.orElse(() => Option.none<PartyReceipt>()),
  );
};
const nativeHashMatches = Effect.fn('SymmyOrganizationSource.nativeHashMatches')(function* nativeHashMatches(
  state: RetainedEffect,
  legalEntityId: string,
) {
  const principalId = Option.getOrUndefined(state.ownerExecutorPrincipalId ?? Option.none());
  const requestHash = Option.getOrUndefined(state.ownerRequestHash ?? Option.none());
  if (principalId === undefined || requestHash === undefined) {
    return false;
  }
  const effect = Option.getOrElse(materializedEffect(state), () => state.effect);
  const intent = Schema.decodeUnknownOption(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(
    effect.intent,
  );
  if (Option.isNone(intent)) {
    return false;
  }
  const principal = { legalEntityId, principalId, tenantId: effect.ref.occurrence.record.route.tenantId };
  const hash = yield* Match.value(intent.value).pipe(
    Match.tag('PartyCreate', (value) =>
      createPartyRequestIdentity(value.payload).pipe(
        Effect.map((identity) => computeActionRequestHash({ ...identity, principal })),
        Effect.option,
      ),
    ),
    Match.tag('PartyMatch', (value) =>
      matchPartyRequestIdentity(value.payload).pipe(
        Effect.map((identity) => computeActionRequestHash({ ...identity, principal })),
        Effect.option,
      ),
    ),
    Match.tag('OnboardCounterpartyCustomer', (value) =>
      counterpartyCustomerOnboardRequestIdentity(value.payload).pipe(
        Effect.map((identity) => computeActionRequestHash({ ...identity, principal })),
        Effect.option,
      ),
    ),
    Match.tag('CreateCounterpartyProfile', (value) =>
      createCounterpartyPurchasingProfileRequestIdentity(value.payload).pipe(
        Effect.map((identity) => computeActionRequestHash({ ...identity, principal })),
        Effect.option,
      ),
    ),
    Match.orElse(() => Effect.succeed(Option.none<string>())),
  );
  return Option.isSome(hash) && hash.value === requestHash;
});
const expectedWitness = (
  effect: SymmyPinnedEffect,
  projection: SourceProjection,
  originalAdmissionInvocationId: string,
) => ({
  effectId: effect.ref.effectId,
  originalAdmissionInvocationId,
  semanticInputDigest: projection.inputDigest,
  semanticProjectionVersion: projection.projectionVersion,
});
const onboardNativeFromRetained = (
  effect: SymmyPinnedEffect,
  state: RetainedEffect,
  party: PartyReceipt,
  projection: SourceProjection,
  originalAdmissionInvocationId: string,
): Option.Option<Extract<NativeIntent, { readonly _tag: 'OnboardCounterpartyCustomer' }>> => {
  const resolved = materializedEffect(state);
  if (effect.intent === undefined || Option.isNone(resolved) || resolved.value.intent === undefined) {
    return Option.none();
  }
  const native = Match.value(resolved.value.intent).pipe(
    Match.tag('OnboardCounterpartyCustomer', (value) => Option.some<NativeOnboard>(value)),
    Match.orElse(() => Option.none<NativeOnboard>()),
  );
  if (Option.isNone(native)) {
    return Option.none();
  }
  return Match.value(effect.intent).pipe(
    Match.tag('OnboardCounterpartyCustomerFromParty', (original) => {
      const expected = resolveSymmyCounterpartyOnboardParty(original, party);
      const decoded = Schema.decodeUnknownOption(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })({
        ...expected,
        payload: {
          ...expected.payload,
          sourceOrganizationWitness: expectedWitness(effect, projection, originalAdmissionInvocationId),
        },
      });
      return Option.isSome(decoded) && sameIntent(decoded.value, native.value) ? native : Option.none();
    }),
    Match.orElse(() => Option.none()),
  );
};
const collectRetainedContext = Effect.fn('SymmyOrganizationSource.collectRetained')(function* collectRetained(
  input: MaterializationInput,
): Effect.fn.Return<Option.Option<RetainedMaterializationContext>> {
  const { effect, legalEntityId, plan, projection, states } = input;
  const selected = exactState(states, effect);
  if (
    Option.isNone(selected) ||
    !hasNativeIdentity(selected.value) ||
    ['planned', 'blocked'].includes(selected.value.state) ||
    !(yield* nativeHashMatches(selected.value, legalEntityId))
  ) {
    return Option.none();
  }
  const found = yield* Effect.forEach(
    projection.parents,
    Effect.fn('SymmyOrganizationSource.collectParent')(function* collectParent(reference) {
      const accepted = effectForName(plan, reference);
      if (Option.isNone(accepted)) {
        return Option.none<RetainedEffect>();
      }
      const parent = exactState(states, accepted.value);
      return Option.isSome(parent) &&
        successfulParent(parent.value) &&
        (yield* nativeHashMatches(parent.value, legalEntityId))
        ? parent
        : Option.none<RetainedEffect>();
    }),
    { concurrency: 1 },
  );
  const parents = found.flatMap((value) => Option.toArray(value));
  if (parents.length !== projection.parents.length) {
    return Option.none();
  }
  const parties = parents.flatMap((state) =>
    Option.toArray(retainedPartyReceipt(state, effect.ref.occurrence.record.route.tenantId)),
  );
  const [party] = parties;
  if (parties.length !== 1 || party === undefined) {
    return Option.none();
  }
  const references = Schema.decodeUnknownOption(
    SymmySourceOrganizationFactsMaterializedSchema.fields.materialization.fields.parents,
  )(
    parents.flatMap((state) => {
      const actionInvocationId = Option.getOrUndefined(state.ownerInvocationId ?? Option.none());
      return actionInvocationId === undefined ? [] : [{ actionInvocationId, effectId: state.effect.ref.effectId }];
    }),
  );
  return Option.isSome(references)
    ? Option.some({ ...input, parents, party, references: references.value, selected: selected.value })
    : Option.none();
});
const onboardMaterialization = Effect.fn('SymmyOrganizationSource.onboardMaterialization')(
  function* onboardMaterialization(
    context: RetainedMaterializationContext,
  ): Effect.fn.Return<Option.Option<Materialization>> {
    if (context.parents.length !== 1) {
      return Option.none();
    }
    const native = onboardNativeFromRetained(
      context.effect,
      context.selected,
      context.party,
      context.projection,
      context.originalAdmissionInvocationId,
    );
    if (Option.isNone(native)) {
      return Option.none();
    }
    const digest = yield* organizationBusinessRecordInputDigest({
      operation: 'ONBOARD_COUNTERPARTY_CUSTOMER',
      payload: native.value.payload,
    }).pipe(Effect.option);
    return Option.isSome(digest)
      ? Option.some({
          inputDigest: digest.value.inputDigest,
          parents: context.references,
          projectionVersion: digest.value.projectionVersion,
          target: { kind: 'PARTY', partyRef: context.party.partyRef },
        })
      : Option.none();
  },
);
const fullOnboardReceipt = (
  state: RetainedEffect,
  party: PartyReceipt,
  legalEntityId: string,
): Option.Option<
  OnboardReceipt & {
    readonly legalEntityRef: NonNullable<OnboardReceipt['legalEntityRef']>;
    readonly rolePeriodRef: NonNullable<OnboardReceipt['rolePeriodRef']>;
  }
> => {
  const receipt = Option.getOrUndefined(state.ownerReceipt ?? Option.none());
  if (receipt === undefined) {
    return Option.none();
  }
  return Match.value(receipt).pipe(
    Match.tag('CounterpartyCustomerOnboarded', (value) => {
      const { legalEntityRef, rolePeriodRef } = value;
      const { tenantId } = party.partyRef;
      return legalEntityRef !== undefined &&
        rolePeriodRef !== undefined &&
        value.partyRef.tenantId === tenantId &&
        value.counterpartyRef.tenantId === tenantId &&
        legalEntityRef.tenantId === tenantId &&
        rolePeriodRef.tenantId === tenantId &&
        legalEntityRef.resourceId === legalEntityId &&
        Schema.toEquivalence(PartyRefSchema)(value.partyRef, party.partyRef)
        ? Option.some({ ...value, legalEntityRef, rolePeriodRef })
        : Option.none();
    }),
    Match.orElse(() => Option.none()),
  );
};
const profileNativeFromRetained = (
  context: RetainedMaterializationContext,
  intent: Extract<NativeIntent, { readonly _tag: 'CreateCounterpartyProfileFromCounterparty' }>,
  receipt: OnboardReceipt,
): Option.Option<Extract<NativeIntent, { readonly _tag: 'CreateCounterpartyProfile' }>> => {
  const resolved = materializedEffect(context.selected);
  if (Option.isNone(resolved) || resolved.value.intent === undefined) {
    return Option.none();
  }
  return Match.value(resolved.value.intent).pipe(
    Match.tag('CreateCounterpartyProfile', (value) => {
      const expected = resolveSymmyCounterpartyProfileCounterparty(intent, receipt);
      const decoded = Schema.decodeUnknownOption(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })({
        ...expected,
        payload: {
          ...expected.payload,
          sourceOrganizationWitness: expectedWitness(
            context.effect,
            context.projection,
            context.originalAdmissionInvocationId,
          ),
        },
      });
      return Option.isSome(decoded) &&
        sameIntent(decoded.value, value) &&
        value.payload.subject.sellingLegalEntityRef?.resourceId === context.legalEntityId
        ? Option.some(value)
        : Option.none();
    }),
    Match.orElse(() => Option.none()),
  );
};
const profileMaterialization = Effect.fn('SymmyOrganizationSource.profileMaterialization')(
  function* profileMaterialization(
    context: RetainedMaterializationContext,
    intent: Extract<NativeIntent, { readonly _tag: 'CreateCounterpartyProfileFromCounterparty' }>,
  ): Effect.fn.Return<Option.Option<Materialization>> {
    if (context.parents.length !== 2) {
      return Option.none();
    }
    const found = context.parents.filter(
      (state) => state.effect.ref.operation.entrypointKey === 'party.registry.counterparty-customer-onboard',
    );
    const [parent] = found;
    if (found.length !== 1 || parent === undefined) {
      return Option.none();
    }
    const projection = yield* projectSymmyOrganizationAcceptedEffect(context.plan, parent.effect);
    if (
      Option.isNone(projection) ||
      Option.isNone(
        onboardNativeFromRetained(
          parent.effect,
          parent,
          context.party,
          projection.value,
          context.originalAdmissionInvocationId,
        ),
      )
    ) {
      return Option.none();
    }
    const onboard = fullOnboardReceipt(parent, context.party, context.legalEntityId);
    if (Option.isNone(onboard)) {
      return Option.none();
    }
    const native = profileNativeFromRetained(context, intent, onboard.value);
    if (Option.isNone(native)) {
      return Option.none();
    }
    const inputDigest = yield* fingerprintOrganizationProfileSourceCreate(native.value.payload).pipe(Effect.option);
    return Option.isSome(inputDigest)
      ? Option.some({
          inputDigest: inputDigest.value,
          parents: context.references,
          projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
          target: {
            counterpartyRef: onboard.value.counterpartyRef,
            kind: 'COUNTERPARTY_CUSTOMER',
            legalEntityRef: onboard.value.legalEntityRef,
            partyRef: onboard.value.partyRef,
            rolePeriodRef: onboard.value.rolePeriodRef,
          },
        })
      : Option.none();
  },
);
/** Retained materialization only: live Core invocation facts and current Party rules remain separate mandatory checks. */
export const selectSymmyOrganizationMaterialization = Effect.fn('SymmyOrganizationSource.selectMaterialization')(
  function* selectMaterialization(input: MaterializationInput): Effect.fn.Return<
    Option.Option<{
      readonly materialization: Materialization;
      readonly parents: readonly RetainedEffect[];
    }>
  > {
    const context = yield* collectRetainedContext(input);
    if (Option.isNone(context) || input.effect.intent === undefined) {
      return Option.none();
    }
    const materialization = yield* Match.value(input.effect.intent).pipe(
      Match.tag('OnboardCounterpartyCustomerFromParty', () => onboardMaterialization(context.value)),
      Match.tag('CreateCounterpartyProfileFromCounterparty', (intent) => profileMaterialization(context.value, intent)),
      Match.orElse(() => Effect.succeed(Option.none<Materialization>())),
    );
    return materialization.pipe(Option.map((value) => ({ materialization: value, parents: context.value.parents })));
  },
);

/** All SELECTs are nonlocking: an outer owner may hold the execution fence through its write. */
export const symmySourceOrganizationFactsServices: ReadServiceFactory<SymmySourceOrganizationFactsServices> = Effect.fn(
  'SymmyOrganizationSource.services',
)((transaction, scope) => {
  const workload = readVerifiedGatewayWorkload(scope);
  const currentRouteColumns = {
    currentActive: symmyJobRoutes.active,
    currentLegalEntityId: symmyJobRoutes.legalEntityId,
    currentMappingVersion: symmyJobRoutes.mappingVersion,
    currentOperatorPrincipalId: symmyJobRoutes.principalId,
    currentRouteRevision: symmyJobRoutes.routeRevision,
  };
  const loadJob = Effect.fn('SymmyOrganizationSource.loadJob')(function* loadJob(selector: {
    readonly by: 'admission' | 'execution';
    readonly id: string;
  }) {
    const rows = yield* transaction
      .select({
        ...currentRouteColumns,
        acceptedAdmissionInvocationId: symmyImportJobs.admissionInvocationId,
        executionPlan: symmyImportJobs.executionPlan,
        intentDigest: symmyImportJobs.intentDigest,
        jobId: symmyImportJobs.jobId,
        legalEntityId: symmyImportJobs.legalEntityId,
        mappingVersion: symmyImportJobs.mappingVersion,
        operatorPrincipalId: symmyImportJobs.principalId,
        retentionPurged: isNull(symmyImportJobs.executionPlan),
        routeId: symmyImportJobs.routeId,
        routeRevision: symmyImportJobs.routeRevision,
      })
      .from(symmyImportJobs)
      .innerJoin(
        symmyJobRoutes,
        and(eq(symmyJobRoutes.tenantId, symmyImportJobs.tenantId), eq(symmyJobRoutes.routeId, symmyImportJobs.routeId)),
      )
      .where(
        and(
          eq(symmyImportJobs.tenantId, scope.tenantId),
          selector.by === 'admission'
            ? eq(symmyImportJobs.admissionInvocationId, selector.id)
            : eq(symmyImportJobs.jobId, selector.id),
        ),
      )
      .limit(2)
      .pipe(Effect.mapError(unavailable));
    if (rows.length > 1) {
      return yield* unavailable();
    }
    const [row] = rows;
    if (row === undefined) {
      return Option.none();
    }
    return Option.some(
      yield* Schema.decodeUnknownEffect(rowSchema)({ ...row, execution: { jobId: row.jobId, kind: 'JOB' } }).pipe(
        Effect.mapError(unavailable),
      ),
    );
  });
  const loadSync = Effect.fn('SymmyOrganizationSource.loadSync')(function* loadSync(selector: {
    readonly by: 'admission' | 'execution';
    readonly id: string;
  }) {
    const query = transaction
      .select({
        ...currentRouteColumns,
        acceptedAdmissionInvocationId: symmySyncAdmissions.admissionId,
        executionPlan: symmySyncAdmissions.executionPlan,
        intentDigest: symmySyncAdmissions.intentDigest,
        legalEntityId: symmySyncAdmissions.legalEntityId,
        mappingVersion: symmySyncAdmissions.mappingVersion,
        operatorPrincipalId: symmySyncAdmissions.principalId,
        retentionPurged: isNotNull(symmySyncAdmissions.retentionReceipt),
        routeId: symmySyncAdmissions.routeId,
        routeRevision: symmySyncAdmissions.routeRevision,
      })
      .from(symmySyncAdmissions)
      .innerJoin(
        symmyJobRoutes,
        and(
          eq(symmyJobRoutes.tenantId, symmySyncAdmissions.tenantId),
          eq(symmyJobRoutes.routeId, symmySyncAdmissions.routeId),
        ),
      );
    const rows = yield* (
      selector.by === 'admission'
        ? query
            .innerJoin(
              symmySyncAdmissionAttempts,
              and(
                eq(symmySyncAdmissionAttempts.tenantId, symmySyncAdmissions.tenantId),
                eq(symmySyncAdmissionAttempts.admissionId, symmySyncAdmissions.admissionId),
              ),
            )
            .where(
              and(
                eq(symmySyncAdmissions.tenantId, scope.tenantId),
                eq(symmySyncAdmissionAttempts.invocationId, selector.id),
              ),
            )
            .limit(2)
        : query
            .where(
              and(eq(symmySyncAdmissions.tenantId, scope.tenantId), eq(symmySyncAdmissions.admissionId, selector.id)),
            )
            .limit(2)
    ).pipe(Effect.mapError(unavailable));
    if (rows.length > 1) {
      return yield* unavailable();
    }
    const [row] = rows;
    if (row === undefined) {
      return Option.none();
    }
    return Option.some(
      yield* Schema.decodeUnknownEffect(rowSchema)({
        ...row,
        // Retention leaves a non-business tombstone rather than a native command plan.
        execution: { admissionId: row.acceptedAdmissionInvocationId, kind: 'SYNC' },
        executionPlan: row.retentionPurged === true ? null : row.executionPlan,
      }).pipe(Effect.mapError(unavailable)),
    );
  });
  const loadSelected = Effect.fn('SymmyOrganizationSource.loadSelected')(function* loadSelected(
    input: SymmySourceOrganizationFactsRequest,
  ) {
    if (input.purpose === 'GOVERNANCE') {
      return yield* Match.value(input.execution).pipe(
        Match.when({ kind: 'JOB' }, (value) => loadJob({ by: 'execution', id: value.jobId })),
        Match.when({ kind: 'SYNC' }, (value) => loadSync({ by: 'execution', id: value.admissionId })),
        Match.exhaustive,
      );
    }
    if (workload?.sourceMode === 'worker') {
      return yield* loadJob({ by: 'admission', id: input.originalAdmissionInvocationId });
    }
    return yield* loadSync({ by: 'admission', id: input.originalAdmissionInvocationId });
  });
  const loadMaterialization = Effect.fn('SymmyOrganizationSource.loadMaterialization')(function* loadMaterialization(
    row: StoredSourceRow,
    input: Extract<SymmySourceOrganizationFactsRequest, { readonly purpose: 'PROCESSING' }>,
    effect: SymmyPinnedEffect,
    plan: typeof SymmyPinnedJobPlanSchema.Type,
    projection: SourceProjection,
  ) {
    if (
      row.execution.kind !== 'JOB' ||
      scope.legalEntityId === undefined ||
      input.materializationWitness === undefined
    ) {
      return Option.none();
    }
    const rows = yield* transaction
      .select({
        effect: symmyJobEffects.effect,
        outcome: symmyJobEffects.outcome,
        ownerAuthContextRef: symmyJobEffects.ownerAuthContextRef,
        ownerExecutorPrincipalId: symmyJobEffects.ownerExecutorPrincipalId,
        ownerInvocationId: symmyJobEffects.ownerInvocationId,
        ownerReceipt: symmyJobEffects.ownerReceipt,
        ownerRequestHash: symmyJobEffects.ownerRequestHash,
        resolvedEffect: symmyJobEffects.resolvedEffect,
        state: symmyJobEffects.state,
        version: symmyJobEffects.version,
      })
      .from(symmyJobEffects)
      .where(and(eq(symmyJobEffects.tenantId, scope.tenantId), eq(symmyJobEffects.jobId, row.execution.jobId)))
      .limit(513)
      .pipe(Effect.mapError(unavailable));
    if (rows.length > 512) {
      return yield* unavailable();
    }
    const states = yield* Schema.decodeUnknownEffect(Schema.Array(SymmyExecutionEffectStateSchema))(rows).pipe(
      Effect.mapError(unavailable),
    );
    const retained = yield* selectSymmyOrganizationMaterialization({
      effect,
      legalEntityId: scope.legalEntityId,
      originalAdmissionInvocationId: input.originalAdmissionInvocationId,
      plan,
      projection,
      states,
    });
    if (
      Option.isNone(retained) ||
      retained.value.materialization.inputDigest !== input.materializationWitness.inputDigest ||
      retained.value.materialization.projectionVersion !== input.materializationWitness.projectionVersion
    ) {
      return Option.none();
    }
    const currentParents = yield* Effect.forEach(
      retained.value.parents,
      Effect.fn('SymmyOrganizationSource.currentParent')(function* currentParent(parent) {
        const originalPrincipalId = Option.getOrUndefined(parent.ownerExecutorPrincipalId ?? Option.none());
        const requestHash = Option.getOrUndefined(parent.ownerRequestHash ?? Option.none());
        const authContextRef = Option.getOrUndefined(parent.ownerAuthContextRef ?? Option.none());
        const actionInvocationId = Option.getOrUndefined(parent.ownerInvocationId ?? Option.none());
        if (
          originalPrincipalId === undefined ||
          requestHash === undefined ||
          authContextRef === undefined ||
          actionInvocationId === undefined
        ) {
          return false;
        }
        const fact = yield* readScopedOriginalActionInvocation(transaction, {
          actionKey: parent.effect.ref.operation.entrypointKey,
          authContextRef,
          idempotencyKey: parent.effect.ref.effectId,
          originalPrincipalId,
          requestHash,
        }).pipe(Effect.mapError(unavailable));
        return (
          Option.isSome(fact) &&
          fact.value.status === 'succeeded' &&
          fact.value.actionInvocationId === actionInvocationId
        );
      }),
      { concurrency: 1 },
    );
    if (!currentParents.every(Boolean)) {
      return Option.none<Materialization>();
    }
    return Option.some(retained.value.materialization);
  });
  const materializationForPurpose = Effect.fn('SymmyOrganizationSource.materializationForPurpose')(
    function* materializationForPurpose(
      row: StoredSourceRow,
      input: SymmySourceOrganizationFactsRequest,
      effect: SymmyPinnedEffect,
      plan: typeof SymmyPinnedJobPlanSchema.Type,
      projection: SourceProjection,
    ) {
      if (input.purpose === 'GOVERNANCE') {
        return Option.some(Option.none<Materialization>());
      }
      if (projection.parents.length === 0) {
        return input.materializationWitness === undefined
          ? Option.some(Option.none<Materialization>())
          : Option.none<Option.Option<Materialization>>();
      }
      return (yield* loadMaterialization(row, input, effect, plan, projection)).pipe(Option.map(Option.some));
    },
  );
  const currentAuthority = Effect.fn('SymmyOrganizationSource.currentAuthority')(function* currentAuthority(
    row: StoredSourceRow,
    ids: { readonly acceptedAdmissionInvocationId: string; readonly originalAdmissionInvocationId: string },
  ) {
    const { acceptedAdmissionInvocationId, originalAdmissionInvocationId } = ids;
    const authority = yield* readScopedSourceAdmissionEnrollment(
      transaction,
      originalAdmissionInvocationId,
      'integration.symmy-admit',
    ).pipe(Effect.mapError(unavailable));
    if (
      Option.isNone(authority) ||
      authority.value.state !== 'open' ||
      authority.value.originalPrincipalId !== row.operatorPrincipalId
    ) {
      return Option.none();
    }
    const expectedAction =
      row.execution.kind === 'JOB' ? 'integration.symmy.admit-symmy-job' : 'integration.symmy.admit-symmy-sync';
    if (authority.value.actionKey !== expectedAction) {
      return Option.none();
    }
    if (originalAdmissionInvocationId !== acceptedAdmissionInvocationId) {
      const accepted = yield* readScopedSourceExecutionFence(transaction, acceptedAdmissionInvocationId).pipe(
        Effect.mapError(unavailable),
      );
      if (
        Option.isNone(accepted) ||
        accepted.value.state !== 'open' ||
        accepted.value.originalPrincipalId !== row.operatorPrincipalId ||
        accepted.value.actionKey !== expectedAction
      ) {
        return Option.none();
      }
    }
    return Option.some(ids);
  });
  return Effect.succeed({
    readSourceOrganizationFacts: Effect.fn('SymmyOrganizationSource.read')(function* read(input) {
      const decision = symmyOrganizationSourceCallerDecision(scope, input);
      if (decision === 'forbidden') {
        return yield* forbidden();
      }
      if (decision === 'not_current') {
        return notCurrent;
      }
      const saved = yield* loadSelected(input);
      if (Option.isNone(saved)) {
        return notCurrent;
      }
      const row = saved.value;
      if (!rowIsCurrent(row, scope.legalEntityId)) {
        return notCurrent;
      }
      const plan = Option.getOrUndefined(row.executionPlan);
      const acceptedAdmissionInvocationId = Option.getOrUndefined(row.acceptedAdmissionInvocationId);
      if (plan === undefined || acceptedAdmissionInvocationId === undefined) {
        return notCurrent;
      }
      if (input.purpose === 'PROCESSING' && workload?.originalPrincipalId !== row.operatorPrincipalId) {
        return notCurrent;
      }
      const originalAdmissionInvocationId =
        input.purpose === 'PROCESSING' ? input.originalAdmissionInvocationId : acceptedAdmissionInvocationId;
      const authority = yield* currentAuthority(row, { acceptedAdmissionInvocationId, originalAdmissionInvocationId });
      if (Option.isNone(authority)) {
        return notCurrent;
      }
      const selected = selectNamedEffect(plan, input);
      if (Option.isNone(selected) || selected.value.ref.occurrence.record.route.tenantId !== scope.tenantId) {
        return notCurrent;
      }
      const effect = selected.value;
      const projection = yield* projectSymmyOrganizationAcceptedEffect(plan, effect);
      if (Option.isNone(projection)) {
        return notCurrent;
      }
      const materialization = yield* materializationForPurpose(row, input, effect, plan, projection.value);
      if (Option.isNone(materialization)) {
        return notCurrent;
      }
      const response = {
        ...projection.value,
        acceptedAdmissionInvocationId,
        admittedIntentDigest: row.intentDigest,
        classification: 'SOURCE_ASSERTED_ORGANIZATION',
        effectId: effect.ref.effectId,
        enrollmentMappingVersion: row.mappingVersion,
        enrollmentRouteId: row.routeId,
        enrollmentRouteRevision: row.routeRevision,
        execution: row.execution,
        logicalRoute: effect.ref.occurrence.record.route,
        mappingVersion: effect.ref.mappingVersion,
        operation: effect.ref.operation,
        originalAdmissionInvocationId,
        outcome: 'CURRENT_SOURCE_ASSERTED_ORGANIZATION',
        routeRevision: effect.ref.routeRevision,
      };
      return yield* Schema.decodeUnknownEffect(SymmySourceOrganizationFactsResponseSchema)(
        Option.match(materialization.value, {
          onNone: () => response,
          onSome: (value) => ({ ...response, materialization: value }),
        }),
      ).pipe(Effect.mapError(unavailable));
    }),
  });
});
