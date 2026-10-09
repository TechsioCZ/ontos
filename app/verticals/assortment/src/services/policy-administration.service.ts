import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type {
  AssortmentBindingAudience,
  CreateApplicabilityBindingPayload,
  CreateRulePayload,
  CreateRuleRevisionPayload,
  EndApplicabilityBindingPayload,
  ReplaceApplicabilityBindingPayload,
  RetireRulePayload,
} from '../../shared/actions/policy-administration.ts';
import {
  applicabilityBindingEndFacts,
  applicabilityBindings,
  ruleRetirementFacts,
  ruleRevisions,
  stableRules,
} from '../database/schema.ts';
import {
  AssortmentPolicyConflictKindSchema,
  AssortmentPolicyPersistenceUnavailable,
} from '../../shared/domain/policy-errors.ts';
import type { AssortmentPolicyConflictKind } from '../../shared/domain/policy-errors.ts';

type PersistenceUnavailable = InstanceType<typeof AssortmentPolicyPersistenceUnavailable>;

// Keep the owner-local persistence capability behind the service factory.  The
// Action boundary only receives AssortmentPolicyPersistence; this inferred
// transaction type avoids leaking Core's executor name into the governed
// handler dependency graph.
type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const MODULE_KEY = 'commerce.assortment' as const;
const STABLE_RULE_TYPE = 'commerce.assortment.stable-rule' as const;
const RULE_REVISION_TYPE = 'commerce.assortment.rule-revision' as const;
const BINDING_TYPE = 'commerce.assortment.applicability-binding' as const;

export const stableRuleRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: STABLE_RULE_TYPE,
  tenantId,
});
export const ruleRevisionRef = (tenantId: string, resourceId: string, revision: number) => ({
  ownerModuleId: MODULE_KEY,
  revision: String(revision),
  sourceRef: { moduleId: MODULE_KEY, resourceId, resourceType: RULE_REVISION_TYPE, tenantId },
});
export const bindingRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: BINDING_TYPE,
  tenantId,
});

const CanonicalJsonSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(CanonicalJsonSchema),
    Schema.Record(Schema.String, CanonicalJsonSchema),
  ]),
);
const CanonicalJsonRecordSchema = Schema.Record(Schema.String, CanonicalJsonSchema);
const JsonStringSchema = Schema.fromJsonString(CanonicalJsonSchema);
const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (Schema.is(CanonicalJsonRecordSchema)(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
};
const canonicalize = <Value extends object>(value: Value): string => {
  const decoded = Result.getOrThrow(Schema.decodeUnknownResult(CanonicalJsonSchema)(value));
  return Result.getOrThrow(Schema.encodeResult(JsonStringSchema)(canonicalJson(decoded)));
};

export const assortmentMeaningFingerprint = <Value extends object>(value: Value): string => {
  const canonical = canonicalize(value);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
};

export type PolicyConflict = Readonly<{ readonly conflict: AssortmentPolicyConflictKind; readonly kind: 'conflict' }>;
const PolicyConflictSchema = Schema.Struct({
  conflict: AssortmentPolicyConflictKindSchema,
  kind: Schema.Literal('conflict'),
});
export type PolicyNotFound = Readonly<{ readonly kind: 'not_found' }>;
export type PolicyStale = Readonly<{ readonly kind: 'stale_basis' }>;
export type PolicyLifecycle = Readonly<{ readonly kind: 'lifecycle_conflict' }>;

export interface AssortmentPolicyPersistence {
  readonly createBinding: (
    input: CreateApplicabilityBindingPayload &
      Readonly<{ actionInvocationId: string; actorPrincipalId: string; legalEntityId: string; tenantId: string }>,
  ) => Effect.Effect<
    Readonly<{ readonly bindingId: string; readonly created: boolean }> | PolicyConflict | PolicyNotFound,
    PersistenceUnavailable
  >;
  readonly createRule: (
    input: CreateRulePayload & Readonly<{ actionInvocationId: string; actorPrincipalId: string; tenantId: string }>,
  ) => Effect.Effect<
    | Readonly<{
        readonly created: boolean;
        readonly initialRevisionNumber: number;
        readonly initialRuleRevisionId: string;
        readonly meaningFingerprint: string;
        readonly stableRuleId: string;
      }>
    | PolicyConflict,
    PersistenceUnavailable
  >;
  readonly createRuleRevision: (
    input: CreateRuleRevisionPayload &
      Readonly<{ actionInvocationId: string; actorPrincipalId: string; tenantId: string }>,
  ) => Effect.Effect<
    | Readonly<{
        readonly created: boolean;
        readonly meaningFingerprint: string;
        readonly revisionNumber: number;
        readonly ruleRevisionId: string;
      }>
    | PolicyConflict
    | PolicyNotFound
    | PolicyStale,
    PersistenceUnavailable
  >;
  readonly endBinding: (
    input: EndApplicabilityBindingPayload &
      Readonly<{ actionInvocationId: string; actorPrincipalId: string; legalEntityId: string; tenantId: string }>,
  ) => Effect.Effect<
    Readonly<{ readonly ended: boolean }> | PolicyConflict | PolicyNotFound | PolicyStale | PolicyLifecycle,
    PersistenceUnavailable
  >;
  readonly replaceBinding: (
    input: ReplaceApplicabilityBindingPayload &
      Readonly<{ actionInvocationId: string; actorPrincipalId: string; legalEntityId: string; tenantId: string }>,
  ) => Effect.Effect<
    | Readonly<{ readonly createdBindingId: string; readonly endedBindingId: string; readonly replaced: boolean }>
    | PolicyConflict
    | PolicyNotFound
    | PolicyStale
    | PolicyLifecycle,
    PersistenceUnavailable
  >;
  readonly retireRule: (
    input: RetireRulePayload & Readonly<{ actionInvocationId: string; actorPrincipalId: string; tenantId: string }>,
  ) => Effect.Effect<
    Readonly<{ readonly retired: boolean }> | PolicyConflict | PolicyNotFound | PolicyStale,
    PersistenceUnavailable
  >;
}

const unavailable = (cause?: unknown): PersistenceUnavailable => {
  const failure = new AssortmentPolicyPersistenceUnavailable({
    code: 'assortment_policy_persistence_unavailable',
    reason: 'Assortment policy persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const query = <Value, Failure>(effect: Effect.Effect<Value, Failure>): Effect.Effect<Value, PersistenceUnavailable> =>
  effect.pipe(Effect.mapError(unavailable));

const uniqueViolationSqlState = ['23', '505'].join('');
const PolicyWriteConstraintNameSchema = Schema.Literals([
  'assortment_binding_end_facts_binding_uk',
  'assortment_binding_end_facts_idempotency_uk',
  'assortment_bindings_idempotency_uk',
  'assortment_rule_retirement_facts_idempotency_uk',
  'assortment_rule_retirement_facts_rule_uk',
  'assortment_rule_revisions_idempotency_uk',
  'assortment_rule_revisions_stable_number_uk',
  'assortment_stable_rules_code_uk',
  'assortment_stable_rules_idempotency_uk',
]);
type PolicyWriteConstraintName = typeof PolicyWriteConstraintNameSchema.Type;
const policyWriteConflictConstraints = {
  assortment_binding_end_facts_binding_uk: 'LIFECYCLE',
  assortment_binding_end_facts_idempotency_uk: 'IDEMPOTENCY_REUSED',
  assortment_bindings_idempotency_uk: 'IDEMPOTENCY_REUSED',
  assortment_rule_retirement_facts_idempotency_uk: 'IDEMPOTENCY_REUSED',
  assortment_rule_retirement_facts_rule_uk: 'LIFECYCLE',
  assortment_rule_revisions_idempotency_uk: 'IDEMPOTENCY_REUSED',
  assortment_rule_revisions_stable_number_uk: 'STALE_BASIS',
  assortment_stable_rules_code_uk: 'BUSINESS_CODE',
  assortment_stable_rules_idempotency_uk: 'IDEMPOTENCY_REUSED',
} satisfies Readonly<Record<PolicyWriteConstraintName, AssortmentPolicyConflictKind>>;
const mutation = <Value>(
  effect: Effect.Effect<Value, EffectDrizzleQueryError>,
  constraints: Readonly<Record<string, AssortmentPolicyConflictKind>> = policyWriteConflictConstraints,
): Effect.Effect<Value | PolicyConflict, PersistenceUnavailable> =>
  effect.pipe(
    Effect.mapError((failure) => {
      const metadata = findPostgresFailure(
        failure,
        ({ code, constraint }) =>
          code === uniqueViolationSqlState && constraint !== undefined && constraint in constraints,
      );
      const constraint = Option.isSome(metadata) ? metadata.value.constraint : undefined;
      const conflict = constraint === undefined ? undefined : constraints[constraint];
      return conflict === undefined ? unavailable(failure) : { conflict, kind: 'conflict' as const };
    }),
    Effect.catchIf(
      (failure: PersistenceUnavailable | PolicyConflict): failure is PolicyConflict =>
        Schema.is(PolicyConflictSchema)(failure),
      Effect.succeed,
    ),
  );

const selectorTargetAll = () => ({ id: null, ownerModuleId: null, type: null });
const selectorTargetCategory = ({
  categoryRef,
}: Extract<CreateRulePayload['selector'], { readonly kind: 'CATEGORY' }>) => ({
  id: categoryRef.resourceId,
  ownerModuleId: categoryRef.moduleId,
  type: categoryRef.resourceType,
});
const selectorTargetPackageOption = ({
  packageOptionRef,
}: Extract<CreateRulePayload['selector'], { readonly kind: 'PACKAGE_OPTION' }>) => ({
  id: packageOptionRef.resourceId,
  ownerModuleId: packageOptionRef.moduleId,
  type: packageOptionRef.resourceType,
});
const selectorTargetProduct = ({
  productRef,
}: Extract<CreateRulePayload['selector'], { readonly kind: 'PRODUCT' }>) => ({
  id: productRef.resourceId,
  ownerModuleId: productRef.moduleId,
  type: productRef.resourceType,
});
const selectorTargetVariant = ({
  variantRef,
}: Extract<CreateRulePayload['selector'], { readonly kind: 'VARIANT' }>) => ({
  id: variantRef.resourceId,
  ownerModuleId: variantRef.moduleId,
  type: variantRef.resourceType,
});
const selectorTarget = (selector: CreateRulePayload['selector']) =>
  Match.value(selector).pipe(
    Match.discriminatorsExhaustive('kind')({
      ALL: selectorTargetAll,
      CATEGORY: selectorTargetCategory,
      PACKAGE_OPTION: selectorTargetPackageOption,
      PRODUCT: selectorTargetProduct,
      VARIANT: selectorTargetVariant,
    }),
  );

const selectorTenantAll = (): string | undefined => Option.getOrUndefined(Option.none<string>());
const selectorTenantCategory = ({
  categoryRef,
}: Extract<CreateRulePayload['selector'], { readonly kind: 'CATEGORY' }>) => categoryRef.tenantId;
const selectorTenantPackageOption = ({
  packageOptionRef,
}: Extract<CreateRulePayload['selector'], { readonly kind: 'PACKAGE_OPTION' }>) => packageOptionRef.tenantId;
const selectorTenantProduct = ({ productRef }: Extract<CreateRulePayload['selector'], { readonly kind: 'PRODUCT' }>) =>
  productRef.tenantId;
const selectorTenantVariant = ({ variantRef }: Extract<CreateRulePayload['selector'], { readonly kind: 'VARIANT' }>) =>
  variantRef.tenantId;
const selectorTenant = (selector: CreateRulePayload['selector']): string | undefined =>
  Match.value(selector).pipe(
    Match.discriminatorsExhaustive('kind')({
      ALL: selectorTenantAll,
      CATEGORY: selectorTenantCategory,
      PACKAGE_OPTION: selectorTenantPackageOption,
      PRODUCT: selectorTenantProduct,
      VARIANT: selectorTenantVariant,
    }),
  );

const trustedTenant = (scope: OperationalScope, tenantId: string, refs: readonly (string | undefined)[]): boolean =>
  tenantId === scope.tenantId && refs.every((ref) => ref === undefined || ref === scope.tenantId);

const ruleMeaning = (input: Pick<CreateRulePayload, 'effect' | 'purpose' | 'selector'>) => ({
  effect: input.effect,
  purpose: input.purpose,
  selector: input.selector,
});

const audienceColumns = (audience: AssortmentBindingAudience) => {
  if (audience.kind === 'SHARED') {
    return {
      bindingKind: 'SHARED' as const,
      customerGroupResourceId: null,
      subjectKind: null,
      subjectResourceId: null,
    };
  }
  if (audience.kind === 'COMMERCE_CUSTOMER_GROUP') {
    return {
      bindingKind: 'COMMERCE_CUSTOMER_GROUP' as const,
      customerGroupResourceId: audience.groupRef.resourceId,
      subjectKind: null,
      subjectResourceId: null,
    };
  }
  const { subject } = audience;
  return {
    bindingKind: 'SUBJECT' as const,
    customerGroupResourceId: null,
    subjectKind: subject.kind,
    subjectResourceId:
      subject.kind === 'COUNTERPARTY' ? subject.counterpartyRef.resourceId : subject.profileRef.resourceId,
  };
};

const audienceTenantId = (audience: AssortmentBindingAudience): string | undefined => {
  if (audience.kind === 'SHARED') {
    return undefined;
  }
  if (audience.kind === 'COMMERCE_CUSTOMER_GROUP') {
    return audience.groupRef.tenantId;
  }
  if (audience.subject.kind === 'COUNTERPARTY') {
    return audience.subject.counterpartyRef.tenantId;
  }
  return audience.subject.profileRef.tenantId;
};

const bindingInputFingerprint = (input: {
  readonly audience: AssortmentBindingAudience;
  readonly commercialScope: CreateApplicabilityBindingPayload['commercialScope'];
  readonly effectiveFrom: CreateApplicabilityBindingPayload['effectiveFrom'];
  readonly ruleRevisionRef: CreateApplicabilityBindingPayload['ruleRevisionRef'];
}) => {
  const audience = audienceColumns(input.audience);
  return assortmentMeaningFingerprint({
    ...audience,
    channelResourceId: input.commercialScope.channelRef.resourceId,
    effectiveFrom: DateTime.formatIso(input.effectiveFrom),
    marketResourceId: input.commercialScope.commerceMarketRef?.resourceId ?? null,
    ruleRevisionId: input.ruleRevisionRef.sourceRef.resourceId,
    storefrontResourceId: input.commercialScope.storefrontRef?.resourceId ?? null,
  });
};

const bindingFingerprint = (row: {
  readonly bindingKind: string;
  readonly channelResourceId: string;
  readonly customerGroupResourceId: string | null;
  readonly effectiveFrom: Date;
  readonly marketResourceId: string | null;
  readonly ruleRevisionId: string;
  readonly storefrontResourceId: string | null;
  readonly subjectKind: string | null;
  readonly subjectResourceId: string | null;
}) =>
  assortmentMeaningFingerprint({
    bindingKind: row.bindingKind,
    channelResourceId: row.channelResourceId,
    customerGroupResourceId: row.customerGroupResourceId,
    effectiveFrom: DateTime.formatIso(DateTime.makeUnsafe(row.effectiveFrom)),
    marketResourceId: row.marketResourceId,
    ruleRevisionId: row.ruleRevisionId,
    storefrontResourceId: row.storefrontResourceId,
    subjectKind: row.subjectKind,
    subjectResourceId: row.subjectResourceId,
  });

type CreateRuleReplayStable = Pick<
  typeof stableRules.$inferSelect,
  | 'actionInvocationId'
  | 'actorPrincipalId'
  | 'idempotencyKey'
  | 'provenanceRef'
  | 'reason'
  | 'stableCode'
  | 'stableRuleId'
>;
type CreateRuleReplayRevision = Pick<
  typeof ruleRevisions.$inferSelect,
  | 'actionInvocationId'
  | 'actorPrincipalId'
  | 'idempotencyKey'
  | 'provenanceRef'
  | 'reason'
  | 'revisionNumber'
  | 'semanticFingerprint'
  | 'stableRuleId'
>;
type CreateRuleReplayInput = CreateRulePayload & Readonly<{ actionInvocationId: string; actorPrincipalId: string }>;

export const matchesCreateRuleReplay = (
  stable: CreateRuleReplayStable,
  revision: CreateRuleReplayRevision,
  input: CreateRuleReplayInput,
): boolean =>
  [
    stable.actionInvocationId === input.actionInvocationId,
    stable.actorPrincipalId === input.actorPrincipalId,
    stable.idempotencyKey === input.actionInvocationId,
    stable.provenanceRef === input.provenanceRef,
    stable.reason === input.reason,
    stable.stableCode === input.stableCode,
    revision.actionInvocationId === input.actionInvocationId,
    revision.actorPrincipalId === input.actorPrincipalId,
    revision.idempotencyKey === input.actionInvocationId,
    revision.provenanceRef === input.provenanceRef,
    revision.reason === input.reason,
    revision.revisionNumber === 1,
    revision.semanticFingerprint === assortmentMeaningFingerprint(ruleMeaning(input)),
    revision.stableRuleId === stable.stableRuleId,
  ].every(Boolean);

type RuleRevisionReplayRow = Pick<
  typeof ruleRevisions.$inferSelect,
  | 'actionInvocationId'
  | 'actorPrincipalId'
  | 'idempotencyKey'
  | 'provenanceRef'
  | 'reason'
  | 'revisionNumber'
  | 'semanticFingerprint'
  | 'stableRuleId'
>;
type RuleRevisionReplayInput = CreateRuleRevisionPayload &
  Readonly<{ actionInvocationId: string; actorPrincipalId: string }>;

export const matchesRuleRevisionReplay = (row: RuleRevisionReplayRow, input: RuleRevisionReplayInput): boolean =>
  [
    row.actionInvocationId === input.actionInvocationId,
    row.actorPrincipalId === input.actorPrincipalId,
    row.idempotencyKey === input.actionInvocationId,
    row.provenanceRef === input.provenanceRef,
    row.reason === input.reason,
    row.semanticFingerprint === assortmentMeaningFingerprint(ruleMeaning(input)),
    row.stableRuleId === input.stableRuleRef.resourceId,
  ].every(Boolean);

type RetirementReplayRow = Pick<
  typeof ruleRetirementFacts.$inferSelect,
  | 'actionInvocationId'
  | 'actorPrincipalId'
  | 'effectiveAt'
  | 'idempotencyKey'
  | 'provenanceRef'
  | 'reason'
  | 'stableRuleId'
>;
type RetirementReplayInput = RetireRulePayload & Readonly<{ actionInvocationId: string; actorPrincipalId: string }>;

export const matchesRetirementReplay = (row: RetirementReplayRow, input: RetirementReplayInput): boolean =>
  [
    row.actionInvocationId === input.actionInvocationId,
    row.actorPrincipalId === input.actorPrincipalId,
    row.effectiveAt.getTime() === DateTime.toDateUtc(input.effectiveAt).getTime(),
    row.idempotencyKey === input.actionInvocationId,
    row.provenanceRef === input.provenanceRef,
    row.reason === input.reason,
    row.stableRuleId === input.stableRuleRef.resourceId,
  ].every(Boolean);

type BindingReplayRow = Pick<
  typeof applicabilityBindings.$inferSelect,
  'actionInvocationId' | 'actorPrincipalId' | 'idempotencyKey' | 'provenanceRef' | 'reason' | 'applicabilityBindingId'
> &
  Parameters<typeof bindingFingerprint>[0];
type BindingReplayInput = CreateApplicabilityBindingPayload &
  Readonly<{ actionInvocationId: string; actorPrincipalId: string }>;

export const matchesBindingReplay = (row: BindingReplayRow, input: BindingReplayInput): boolean =>
  [
    row.actionInvocationId === input.actionInvocationId,
    row.actorPrincipalId === input.actorPrincipalId,
    row.idempotencyKey === input.actionInvocationId,
    row.provenanceRef === input.provenanceRef,
    row.reason === input.reason,
    bindingFingerprint(row) === bindingInputFingerprint(input),
  ].every(Boolean);

type BindingEndReplayRow = Pick<
  typeof applicabilityBindingEndFacts.$inferSelect,
  | 'actionInvocationId'
  | 'actorPrincipalId'
  | 'applicabilityBindingId'
  | 'effectiveAt'
  | 'idempotencyKey'
  | 'provenanceRef'
  | 'reason'
>;
type BindingEndReplayInput = EndApplicabilityBindingPayload &
  Readonly<{ actionInvocationId: string; actorPrincipalId: string }>;

export const matchesBindingEndReplay = (row: BindingEndReplayRow, input: BindingEndReplayInput): boolean =>
  [
    row.actionInvocationId === input.actionInvocationId,
    row.actorPrincipalId === input.actorPrincipalId,
    row.applicabilityBindingId === input.applicabilityBindingRef.resourceId,
    row.effectiveAt.getTime() === DateTime.toDateUtc(input.effectiveAt).getTime(),
    row.idempotencyKey === input.actionInvocationId,
    row.provenanceRef === input.provenanceRef,
    row.reason === input.reason,
  ].every(Boolean);

type ReplacementReplayInput = ReplaceApplicabilityBindingPayload &
  Readonly<{ actionInvocationId: string; actorPrincipalId: string }>;

export const matchesReplacementReplay = (
  binding: BindingReplayRow,
  end: BindingEndReplayRow,
  input: ReplacementReplayInput,
): boolean =>
  [
    binding.actionInvocationId === input.actionInvocationId,
    binding.actorPrincipalId === input.actorPrincipalId,
    binding.applicabilityBindingId !== input.existingBindingRef.resourceId,
    binding.idempotencyKey === input.actionInvocationId,
    binding.provenanceRef === input.provenanceRef,
    binding.reason === input.reason,
    bindingFingerprint(binding) ===
      bindingInputFingerprint({
        audience: input.proposedAudience,
        commercialScope: input.proposedCommercialScope,
        effectiveFrom: input.proposedEffectiveFrom,
        ruleRevisionRef: input.proposedRuleRevisionRef,
      }),
    end.actionInvocationId === input.actionInvocationId,
    end.actorPrincipalId === input.actorPrincipalId,
    end.applicabilityBindingId === input.existingBindingRef.resourceId,
    end.effectiveAt.getTime() === DateTime.toDateUtc(input.effectiveAt).getTime(),
    end.idempotencyKey === input.actionInvocationId,
    end.provenanceRef === input.provenanceRef,
    end.reason === input.reason,
  ].every(Boolean);

const trustedReplacementInput = (
  scope: OperationalScope,
  input: ReplaceApplicabilityBindingPayload & Readonly<{ legalEntityId: string; tenantId: string }>,
): boolean =>
  trustedTenant(scope, input.tenantId, [
    input.existingBindingRef.tenantId,
    input.proposedRuleRevisionRef.sourceRef.tenantId,
    input.proposedCommercialScope.channelRef.tenantId,
    input.proposedCommercialScope.sellingLegalEntityRef.tenantId,
    input.proposedCommercialScope.commerceMarketRef?.tenantId,
    input.proposedCommercialScope.storefrontRef?.tenantId,
    audienceTenantId(input.proposedAudience),
  ]) &&
  scope.legalEntityId === input.legalEntityId &&
  input.proposedCommercialScope.sellingLegalEntityRef.resourceId === input.legalEntityId;

export const assortmentPolicyPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): AssortmentPolicyPersistence => {
  const createRule: AssortmentPolicyPersistence['createRule'] = Effect.fn(
    'assortmentPolicyPersistenceForScope.createRule',
  )(function* createRuleEffect(input) {
    if (!trustedTenant(scope, input.tenantId, [selectorTenant(input.selector)])) {
      return yield* unavailable();
    }
    const byInvocation = yield* query(
      transaction
        .select({
          actionInvocationId: stableRules.actionInvocationId,
          actorPrincipalId: stableRules.actorPrincipalId,
          idempotencyKey: stableRules.idempotencyKey,
          provenanceRef: stableRules.provenanceRef,
          reason: stableRules.reason,
          stableCode: stableRules.stableCode,
          stableRuleId: stableRules.stableRuleId,
        })
        .from(stableRules)
        .where(and(eq(stableRules.tenantId, input.tenantId), eq(stableRules.idempotencyKey, input.actionInvocationId)))
        .limit(1),
    );
    if (byInvocation[0] !== undefined) {
      const revision = yield* query(
        transaction
          .select({
            actionInvocationId: ruleRevisions.actionInvocationId,
            actorPrincipalId: ruleRevisions.actorPrincipalId,
            idempotencyKey: ruleRevisions.idempotencyKey,
            provenanceRef: ruleRevisions.provenanceRef,
            reason: ruleRevisions.reason,
            revisionNumber: ruleRevisions.revisionNumber,
            ruleRevisionId: ruleRevisions.ruleRevisionId,
            semanticFingerprint: ruleRevisions.semanticFingerprint,
            stableRuleId: ruleRevisions.stableRuleId,
          })
          .from(ruleRevisions)
          .where(
            and(
              eq(ruleRevisions.tenantId, input.tenantId),
              eq(ruleRevisions.stableRuleId, byInvocation[0].stableRuleId),
              eq(ruleRevisions.idempotencyKey, input.actionInvocationId),
            ),
          )
          .limit(1),
      );
      const [existingRevision] = revision;
      if (existingRevision === undefined) {
        return yield* unavailable();
      }
      if (!matchesCreateRuleReplay(byInvocation[0], existingRevision, input)) {
        return { conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const };
      }
      return {
        created: false,
        initialRevisionNumber: existingRevision.revisionNumber,
        initialRuleRevisionId: existingRevision.ruleRevisionId,
        meaningFingerprint: existingRevision.semanticFingerprint,
        stableRuleId: byInvocation[0].stableRuleId,
      };
    }
    const duplicate = yield* query(
      transaction
        .select({ stableRuleId: stableRules.stableRuleId })
        .from(stableRules)
        .where(and(eq(stableRules.tenantId, input.tenantId), eq(stableRules.stableCode, input.stableCode)))
        .limit(1),
    );
    const [duplicateRow] = duplicate;
    if (duplicateRow !== undefined) {
      return { conflict: 'BUSINESS_CODE' as const, kind: 'conflict' };
    }
    const rows = yield* mutation(
      transaction
        .insert(stableRules)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          idempotencyKey: input.actionInvocationId,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          stableCode: input.stableCode,
          tenantId: input.tenantId,
        })
        .returning({ stableRuleId: stableRules.stableRuleId }),
    );
    if ('kind' in rows) {
      return rows;
    }
    const [row] = rows;
    if (row === undefined) {
      return yield* unavailable();
    }
    const target = selectorTarget(input.selector);
    const meaningFingerprint = assortmentMeaningFingerprint(ruleMeaning(input));
    const revisions = yield* mutation(
      transaction
        .insert(ruleRevisions)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          effect: input.effect,
          idempotencyKey: input.actionInvocationId,
          provenanceRef: input.provenanceRef,
          purpose: input.purpose,
          reason: input.reason,
          revisionNumber: 1,
          selectorKind: input.selector.kind,
          selectorTargetOwnerModuleId: target.ownerModuleId,
          selectorTargetResourceId: target.id,
          selectorTargetResourceType: target.type,
          semanticFingerprint: meaningFingerprint,
          stableRuleId: row.stableRuleId,
          tenantId: input.tenantId,
        })
        .returning({ revisionNumber: ruleRevisions.revisionNumber, ruleRevisionId: ruleRevisions.ruleRevisionId }),
    );
    if ('kind' in revisions) {
      return revisions;
    }
    const [revision] = revisions;
    return revision === undefined
      ? yield* unavailable()
      : {
          created: true,
          initialRevisionNumber: revision.revisionNumber,
          initialRuleRevisionId: revision.ruleRevisionId,
          meaningFingerprint,
          stableRuleId: row.stableRuleId,
        };
  });

  const createRuleRevision: AssortmentPolicyPersistence['createRuleRevision'] = Effect.fn(
    'assortmentPolicyPersistenceForScope.createRuleRevision',
  )(function* createRuleRevisionEffect(input) {
    if (!trustedTenant(scope, input.tenantId, [input.stableRuleRef.tenantId, selectorTenant(input.selector)])) {
      return yield* unavailable();
    }
    const replay = yield* query(
      transaction
        .select({
          actionInvocationId: ruleRevisions.actionInvocationId,
          actorPrincipalId: ruleRevisions.actorPrincipalId,
          idempotencyKey: ruleRevisions.idempotencyKey,
          provenanceRef: ruleRevisions.provenanceRef,
          reason: ruleRevisions.reason,
          revisionNumber: ruleRevisions.revisionNumber,
          ruleRevisionId: ruleRevisions.ruleRevisionId,
          semanticFingerprint: ruleRevisions.semanticFingerprint,
          stableRuleId: ruleRevisions.stableRuleId,
        })
        .from(ruleRevisions)
        .where(
          and(eq(ruleRevisions.tenantId, input.tenantId), eq(ruleRevisions.idempotencyKey, input.actionInvocationId)),
        )
        .limit(1),
    );
    if (replay[0] !== undefined) {
      if (!matchesRuleRevisionReplay(replay[0], input)) {
        return { conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const };
      }
      return {
        created: false,
        meaningFingerprint: replay[0].semanticFingerprint,
        revisionNumber: replay[0].revisionNumber,
        ruleRevisionId: replay[0].ruleRevisionId,
      };
    }
    const stable = yield* query(
      transaction
        .select({ stableRuleId: stableRules.stableRuleId })
        .from(stableRules)
        .where(
          and(eq(stableRules.tenantId, input.tenantId), eq(stableRules.stableRuleId, input.stableRuleRef.resourceId)),
        )
        .for('update')
        .limit(1),
    );
    if (stable[0] === undefined) {
      return { kind: 'not_found' as const };
    }
    const retirement = yield* query(
      transaction
        .select({ stableRuleId: ruleRetirementFacts.stableRuleId })
        .from(ruleRetirementFacts)
        .where(
          and(
            eq(ruleRetirementFacts.tenantId, input.tenantId),
            eq(ruleRetirementFacts.stableRuleId, input.stableRuleRef.resourceId),
          ),
        )
        .limit(1),
    );
    if (retirement[0] !== undefined) {
      return { conflict: 'LIFECYCLE' as const, kind: 'conflict' as const };
    }
    const latest = yield* query(
      transaction
        .select({ revisionNumber: ruleRevisions.revisionNumber })
        .from(ruleRevisions)
        .where(
          and(
            eq(ruleRevisions.tenantId, input.tenantId),
            eq(ruleRevisions.stableRuleId, input.stableRuleRef.resourceId),
          ),
        )
        .orderBy(desc(ruleRevisions.revisionNumber))
        .limit(1),
    );
    const latestNumber = latest[0]?.revisionNumber ?? 0;
    if (input.expectedLatestRevision !== latestNumber) {
      return { kind: 'stale_basis' as const };
    }
    const target = selectorTarget(input.selector);
    const meaningFingerprint = assortmentMeaningFingerprint(ruleMeaning(input));
    const rows = yield* mutation(
      transaction
        .insert(ruleRevisions)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          effect: input.effect,
          idempotencyKey: input.actionInvocationId,
          provenanceRef: input.provenanceRef,
          purpose: input.purpose,
          reason: input.reason,
          revisionNumber: latestNumber + 1,
          selectorKind: input.selector.kind,
          selectorTargetOwnerModuleId: target.ownerModuleId,
          selectorTargetResourceId: target.id,
          selectorTargetResourceType: target.type,
          semanticFingerprint: meaningFingerprint,
          stableRuleId: input.stableRuleRef.resourceId,
          tenantId: input.tenantId,
        })
        .returning({ revisionNumber: ruleRevisions.revisionNumber, ruleRevisionId: ruleRevisions.ruleRevisionId }),
    );
    if ('kind' in rows) {
      return rows;
    }
    const [row] = rows;
    return row === undefined
      ? yield* unavailable()
      : { created: true, meaningFingerprint, revisionNumber: row.revisionNumber, ruleRevisionId: row.ruleRevisionId };
  });

  const retireRule: AssortmentPolicyPersistence['retireRule'] = Effect.fn(
    'assortmentPolicyPersistenceForScope.retireRule',
  )(function* retireRuleEffect(input) {
    if (!trustedTenant(scope, input.tenantId, [input.stableRuleRef.tenantId])) {
      return yield* unavailable();
    }
    const replay = yield* query(
      transaction
        .select()
        .from(ruleRetirementFacts)
        .where(
          and(
            eq(ruleRetirementFacts.tenantId, input.tenantId),
            eq(ruleRetirementFacts.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    if (replay[0] !== undefined) {
      if (!matchesRetirementReplay(replay[0], input)) {
        return { conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const };
      }
      return { retired: false };
    }
    const stable = yield* query(
      transaction
        .select({ stableCode: stableRules.stableCode, stableRuleId: stableRules.stableRuleId })
        .from(stableRules)
        .where(
          and(eq(stableRules.tenantId, input.tenantId), eq(stableRules.stableRuleId, input.stableRuleRef.resourceId)),
        )
        .for('update')
        .limit(1),
    );
    if (stable[0] === undefined) {
      return { kind: 'not_found' as const };
    }
    const latest = yield* query(
      transaction
        .select({ revisionNumber: ruleRevisions.revisionNumber, ruleRevisionId: ruleRevisions.ruleRevisionId })
        .from(ruleRevisions)
        .where(
          and(
            eq(ruleRevisions.tenantId, input.tenantId),
            eq(ruleRevisions.stableRuleId, input.stableRuleRef.resourceId),
          ),
        )
        .orderBy(desc(ruleRevisions.revisionNumber))
        .limit(1),
    );
    const [latestRevision] = latest;
    if (latestRevision === undefined) {
      return yield* unavailable();
    }
    if (
      input.expectedBasisFingerprint !==
      assortmentMeaningFingerprint({
        latestRevisionId: latestRevision.ruleRevisionId,
        latestRevisionNumber: latestRevision.revisionNumber,
        retired: false,
        stableCode: stable[0].stableCode,
      })
    ) {
      return { kind: 'stale_basis' as const };
    }
    const existing = yield* query(
      transaction
        .select({ stableRuleId: ruleRetirementFacts.stableRuleId })
        .from(ruleRetirementFacts)
        .where(
          and(
            eq(ruleRetirementFacts.tenantId, input.tenantId),
            eq(ruleRetirementFacts.stableRuleId, input.stableRuleRef.resourceId),
          ),
        )
        .limit(1),
    );
    if (existing[0] !== undefined) {
      return { conflict: 'LIFECYCLE' as const, kind: 'conflict' as const };
    }
    const inserted = yield* mutation(
      transaction.insert(ruleRetirementFacts).values({
        actionInvocationId: input.actionInvocationId,
        actorPrincipalId: input.actorPrincipalId,
        effectiveAt: DateTime.toDateUtc(input.effectiveAt),
        idempotencyKey: input.actionInvocationId,
        provenanceRef: input.provenanceRef,
        reason: input.reason,
        stableRuleId: input.stableRuleRef.resourceId,
        tenantId: input.tenantId,
      }),
    );
    if ('kind' in inserted) {
      return inserted;
    }
    return { retired: true };
  });

  const createBinding: AssortmentPolicyPersistence['createBinding'] = Effect.fn(
    'assortmentPolicyPersistenceForScope.createBinding',
  )(function* createBindingEffect(input) {
    const bindingRefs = [
      input.ruleRevisionRef.sourceRef.tenantId,
      input.commercialScope.channelRef.tenantId,
      input.commercialScope.sellingLegalEntityRef.tenantId,
      input.commercialScope.commerceMarketRef?.tenantId,
      input.commercialScope.storefrontRef?.tenantId,
      audienceTenantId(input.audience),
    ];
    if (
      !trustedTenant(scope, input.tenantId, bindingRefs) ||
      scope.legalEntityId !== input.legalEntityId ||
      input.commercialScope.sellingLegalEntityRef.resourceId !== input.legalEntityId
    ) {
      return yield* unavailable();
    }
    const byInvocation = yield* query(
      transaction
        .select()
        .from(applicabilityBindings)
        .where(
          and(
            eq(applicabilityBindings.tenantId, input.tenantId),
            eq(applicabilityBindings.legalEntityId, input.legalEntityId),
            eq(applicabilityBindings.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    if (byInvocation[0] !== undefined) {
      if (!matchesBindingReplay(byInvocation[0], input)) {
        return { conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const };
      }
      return { bindingId: byInvocation[0].applicabilityBindingId, created: false };
    }
    const revision = yield* query(
      transaction
        .select({ ruleRevisionId: ruleRevisions.ruleRevisionId, stableRuleId: ruleRevisions.stableRuleId })
        .from(ruleRevisions)
        .where(
          and(
            eq(ruleRevisions.tenantId, input.tenantId),
            eq(ruleRevisions.ruleRevisionId, input.ruleRevisionRef.sourceRef.resourceId),
          ),
        )
        .limit(1),
    );
    if (revision[0] === undefined) {
      return { kind: 'not_found' as const };
    }
    const stable = yield* query(
      transaction
        .select({ stableRuleId: stableRules.stableRuleId })
        .from(stableRules)
        .where(and(eq(stableRules.tenantId, input.tenantId), eq(stableRules.stableRuleId, revision[0].stableRuleId)))
        .for('update')
        .limit(1),
    );
    if (stable[0] === undefined) {
      return { kind: 'not_found' as const };
    }
    const retirement = yield* query(
      transaction
        .select({ stableRuleId: ruleRetirementFacts.stableRuleId })
        .from(ruleRetirementFacts)
        .where(
          and(
            eq(ruleRetirementFacts.tenantId, input.tenantId),
            eq(ruleRetirementFacts.stableRuleId, revision[0].stableRuleId),
          ),
        )
        .limit(1),
    );
    if (retirement[0] !== undefined) {
      return { conflict: 'LIFECYCLE' as const, kind: 'conflict' as const };
    }
    const audience = audienceColumns(input.audience);
    const rows = yield* mutation(
      transaction
        .insert(applicabilityBindings)
        .values({
          ...audience,
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          channelResourceId: input.commercialScope.channelRef.resourceId,
          effectiveFrom: DateTime.toDateUtc(input.effectiveFrom),
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          marketResourceId: input.commercialScope.commerceMarketRef?.resourceId ?? null,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          ruleRevisionId: input.ruleRevisionRef.sourceRef.resourceId,
          storefrontResourceId: input.commercialScope.storefrontRef?.resourceId ?? null,
          tenantId: input.tenantId,
        })
        .returning({ applicabilityBindingId: applicabilityBindings.applicabilityBindingId }),
    );
    if ('kind' in rows) {
      return rows;
    }
    const [row] = rows;
    return row === undefined ? yield* unavailable() : { bindingId: row.applicabilityBindingId, created: true };
  });

  const endBinding: AssortmentPolicyPersistence['endBinding'] = Effect.fn(
    'assortmentPolicyPersistenceForScope.endBinding',
  )(function* endBindingEffect(input) {
    if (
      !trustedTenant(scope, input.tenantId, [input.applicabilityBindingRef.tenantId]) ||
      scope.legalEntityId !== input.legalEntityId
    ) {
      return yield* unavailable();
    }
    const replay = yield* query(
      transaction
        .select()
        .from(applicabilityBindingEndFacts)
        .where(
          and(
            eq(applicabilityBindingEndFacts.tenantId, input.tenantId),
            eq(applicabilityBindingEndFacts.legalEntityId, input.legalEntityId),
            eq(applicabilityBindingEndFacts.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    if (replay[0] !== undefined) {
      if (!matchesBindingEndReplay(replay[0], input)) {
        return { conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const };
      }
      return { ended: false };
    }
    const binding = yield* query(
      transaction
        .select()
        .from(applicabilityBindings)
        .where(
          and(
            eq(applicabilityBindings.tenantId, input.tenantId),
            eq(applicabilityBindings.legalEntityId, input.legalEntityId),
            eq(applicabilityBindings.applicabilityBindingId, input.applicabilityBindingRef.resourceId),
          ),
        )
        .for('update')
        .limit(1),
    );
    const [row] = binding;
    if (row === undefined) {
      return { kind: 'not_found' as const };
    }
    if (input.expectedBasisFingerprint !== bindingFingerprint(row)) {
      return { kind: 'stale_basis' as const };
    }
    const existing = yield* query(
      transaction
        .select({ applicabilityBindingEndFactId: applicabilityBindingEndFacts.applicabilityBindingEndFactId })
        .from(applicabilityBindingEndFacts)
        .where(
          and(
            eq(applicabilityBindingEndFacts.tenantId, input.tenantId),
            eq(applicabilityBindingEndFacts.legalEntityId, input.legalEntityId),
            eq(applicabilityBindingEndFacts.applicabilityBindingId, input.applicabilityBindingRef.resourceId),
          ),
        )
        .limit(1),
    );
    if (existing[0] !== undefined) {
      return { kind: 'lifecycle_conflict' as const };
    }
    const inserted = yield* mutation(
      transaction.insert(applicabilityBindingEndFacts).values({
        actionInvocationId: input.actionInvocationId,
        actorPrincipalId: input.actorPrincipalId,
        applicabilityBindingId: input.applicabilityBindingRef.resourceId,
        effectiveAt: DateTime.toDateUtc(input.effectiveAt),
        idempotencyKey: input.actionInvocationId,
        legalEntityId: input.legalEntityId,
        provenanceRef: input.provenanceRef,
        reason: input.reason,
        tenantId: input.tenantId,
      }),
    );
    if ('kind' in inserted) {
      return inserted;
    }
    return { ended: true };
  });

  const replaceBinding: AssortmentPolicyPersistence['replaceBinding'] = Effect.fn(
    'assortmentPolicyPersistenceForScope.replaceBinding',
  )(function* replaceBindingEffect(input) {
    const { legalEntityId } = input;
    if (!trustedReplacementInput(scope, input)) {
      return yield* unavailable();
    }
    const replay = yield* query(
      transaction
        .select()
        .from(applicabilityBindings)
        .where(
          and(
            eq(applicabilityBindings.tenantId, input.tenantId),
            eq(applicabilityBindings.legalEntityId, legalEntityId),
            eq(applicabilityBindings.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    if (replay[0] !== undefined) {
      const replayEnds = yield* query(
        transaction
          .select()
          .from(applicabilityBindingEndFacts)
          .where(
            and(
              eq(applicabilityBindingEndFacts.tenantId, input.tenantId),
              eq(applicabilityBindingEndFacts.legalEntityId, legalEntityId),
              eq(applicabilityBindingEndFacts.idempotencyKey, input.actionInvocationId),
            ),
          )
          .limit(1),
      );
      const [replayEnd] = replayEnds;
      if (replayEnd === undefined) {
        return { conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const };
      }
      if (!matchesReplacementReplay(replay[0], replayEnd, input)) {
        return { conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const };
      }
      return {
        createdBindingId: replay[0].applicabilityBindingId,
        endedBindingId: replayEnd.applicabilityBindingId,
        replaced: false,
      };
    }
    const existing = yield* query(
      transaction
        .select()
        .from(applicabilityBindings)
        .where(
          and(
            eq(applicabilityBindings.tenantId, input.tenantId),
            eq(applicabilityBindings.legalEntityId, legalEntityId),
            eq(applicabilityBindings.applicabilityBindingId, input.existingBindingRef.resourceId),
          ),
        )
        .for('update')
        .limit(1),
    );
    const [old] = existing;
    if (old === undefined) {
      return { kind: 'not_found' as const };
    }
    if (input.expectedExistingBasisFingerprint !== bindingFingerprint(old)) {
      return { kind: 'stale_basis' as const };
    }
    const existingEnd = yield* query(
      transaction
        .select({ id: applicabilityBindingEndFacts.applicabilityBindingEndFactId })
        .from(applicabilityBindingEndFacts)
        .where(
          and(
            eq(applicabilityBindingEndFacts.tenantId, input.tenantId),
            eq(applicabilityBindingEndFacts.legalEntityId, legalEntityId),
            eq(applicabilityBindingEndFacts.applicabilityBindingId, input.existingBindingRef.resourceId),
          ),
        )
        .limit(1),
    );
    if (existingEnd[0] !== undefined) {
      return { kind: 'lifecycle_conflict' as const };
    }
    const revision = yield* query(
      transaction
        .select({ id: ruleRevisions.ruleRevisionId, stableRuleId: ruleRevisions.stableRuleId })
        .from(ruleRevisions)
        .where(
          and(
            eq(ruleRevisions.tenantId, input.tenantId),
            eq(ruleRevisions.ruleRevisionId, input.proposedRuleRevisionRef.sourceRef.resourceId),
          ),
        )
        .limit(1),
    );
    if (revision[0] === undefined) {
      return { kind: 'not_found' as const };
    }
    const stable = yield* query(
      transaction
        .select({ stableRuleId: stableRules.stableRuleId })
        .from(stableRules)
        .where(and(eq(stableRules.tenantId, input.tenantId), eq(stableRules.stableRuleId, revision[0].stableRuleId)))
        .for('update')
        .limit(1),
    );
    if (stable[0] === undefined) {
      return { kind: 'not_found' as const };
    }
    const retirement = yield* query(
      transaction
        .select({ stableRuleId: ruleRetirementFacts.stableRuleId })
        .from(ruleRetirementFacts)
        .where(
          and(
            eq(ruleRetirementFacts.tenantId, input.tenantId),
            eq(ruleRetirementFacts.stableRuleId, revision[0].stableRuleId),
          ),
        )
        .limit(1),
    );
    if (retirement[0] !== undefined) {
      return { conflict: 'LIFECYCLE' as const, kind: 'conflict' as const };
    }
    const insertedEnd = yield* mutation(
      transaction.insert(applicabilityBindingEndFacts).values({
        actionInvocationId: input.actionInvocationId,
        actorPrincipalId: input.actorPrincipalId,
        applicabilityBindingId: old.applicabilityBindingId,
        effectiveAt: DateTime.toDateUtc(input.effectiveAt),
        idempotencyKey: input.actionInvocationId,
        legalEntityId,
        provenanceRef: input.provenanceRef,
        reason: input.reason,
        tenantId: input.tenantId,
      }),
    );
    if ('kind' in insertedEnd) {
      return insertedEnd;
    }
    const audience = audienceColumns(input.proposedAudience);
    const rows = yield* mutation(
      transaction
        .insert(applicabilityBindings)
        .values({
          ...audience,
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          channelResourceId: input.proposedCommercialScope.channelRef.resourceId,
          effectiveFrom: DateTime.toDateUtc(input.proposedEffectiveFrom),
          idempotencyKey: input.actionInvocationId,
          legalEntityId,
          marketResourceId: input.proposedCommercialScope.commerceMarketRef?.resourceId ?? null,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          ruleRevisionId: input.proposedRuleRevisionRef.sourceRef.resourceId,
          storefrontResourceId: input.proposedCommercialScope.storefrontRef?.resourceId ?? null,
          tenantId: input.tenantId,
        })
        .returning({ applicabilityBindingId: applicabilityBindings.applicabilityBindingId }),
    );
    if ('kind' in rows) {
      return rows;
    }
    const [created] = rows;
    return created === undefined
      ? yield* unavailable()
      : {
          createdBindingId: created.applicabilityBindingId,
          endedBindingId: old.applicabilityBindingId,
          replaced: true,
        };
  });

  return Object.freeze({
    createBinding,
    createRule,
    createRuleRevision,
    endBinding,
    replaceBinding,
    retireRule,
  });
};

export const assortmentPolicyServiceFactory = (transaction: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(assortmentPolicyPersistenceForScope(transaction, scope));
