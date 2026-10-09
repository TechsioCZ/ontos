import { Effect, Option, Schema } from 'effect';

import {
  StockSharingEligibilityRejected,
  StockSharingEligibilitySchema,
  UnverifiableCommercePurchasingContextSchema,
  commerceScopeMatchesRelation,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import type {
  ChangeStockSharingEligibilityInput,
  EndStockSharingEligibilityInput,
  EstablishStockSharingEligibilityInput,
  EvaluateStockSharingEligibilityInput,
  StockSharingCommerceScopeValidator,
  StockSharingEligibility,
  StockSharingEligibilityPersistence,
  StockSharingEligibilitySubject,
} from '../../shared/domain/stock-sharing-eligibility.ts';

const rejected = (reason: StockSharingEligibilityRejected['reason'], relationRef?: StockSharingEligibility['ref']) =>
  relationRef === undefined
    ? new StockSharingEligibilityRejected({ code: 'stock_sharing_eligibility_rejected', reason })
    : new StockSharingEligibilityRejected({ code: 'stock_sharing_eligibility_rejected', reason, relationRef });

const sameOptionalResource = (
  left: { readonly resourceId: string; readonly tenantId: string } | undefined,
  right: { readonly resourceId: string; readonly tenantId: string } | undefined,
) =>
  left === undefined || right === undefined
    ? left === right
    : left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameSubject = (left: StockSharingEligibilitySubject, right: StockSharingEligibilitySubject) =>
  left.channel === right.channel &&
  left.sellingLegalEntityRef.resourceId === right.sellingLegalEntityRef.resourceId &&
  left.sellingLegalEntityRef.tenantId === right.sellingLegalEntityRef.tenantId &&
  sameOptionalResource(left.commerceMarketRef, right.commerceMarketRef) &&
  (left.storefrontRef === undefined || right.storefrontRef === undefined
    ? left.storefrontRef === right.storefrontRef
    : left.storefrontRef.appId === right.storefrontRef.appId &&
      left.storefrontRef.tenantId === right.storefrontRef.tenantId);

const candidate = (
  input: EstablishStockSharingEligibilityInput,
  commerceValidation: StockSharingEligibility['commerceValidation'],
  relationId: string,
) =>
  Schema.decodeEffect(StockSharingEligibilitySchema)({
    commerceValidation,
    effectivePeriod: { from: input.effectiveFrom, to: null },
    lifecycle: 'CURRENT',
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: relationId,
      resourceType: 'commerce.inventory.stock-sharing-eligibility',
      tenantId: input.scope.positionRef.tenantId,
    },
    revision: 1,
    scope: input.scope,
    subject: input.subject,
  }).pipe(Effect.mapError((cause) => Object.assign(rejected('INVALID_RELATION'), { cause })));

const requireCurrent = (
  relationRef: StockSharingEligibility['ref'],
  relation: Option.Option<StockSharingEligibility>,
) =>
  Option.match(relation, {
    onNone: () => Effect.fail(rejected('RELATION_NOT_FOUND', relationRef)),
    onSome: (value) =>
      value.lifecycle === 'CURRENT'
        ? Effect.succeed(value)
        : Effect.fail(rejected('RELATION_NOT_CURRENT', relationRef)),
  });

export const makeStockSharingEligibilityEvaluator = (persistence: StockSharingEligibilityPersistence) => ({
  evaluate: Effect.fn('StockSharingEligibilityService.evaluate')(function* evaluateEligibility(
    input: EvaluateStockSharingEligibilityInput,
  ) {
    if (Schema.is(UnverifiableCommercePurchasingContextSchema)(input.context)) {
      return yield* rejected('COMMERCE_CONTEXT_UNVERIFIABLE');
    }
    const { context, scope } = input;
    if (
      context.tenantId !== scope.positionRef.tenantId ||
      context.customerConfigurationId !== scope.customerConfigurationId
    ) {
      return yield* rejected('POSITION_SCOPE_MISMATCH');
    }
    const relations = yield* persistence.listCurrent(scope);
    const applicable = relations.filter(
      (relation) => relation.lifecycle === 'CURRENT' && commerceScopeMatchesRelation(relation.subject, context),
    );
    if (applicable.length === 0) {
      return yield* rejected('NO_APPLICABLE_CURRENT_RELATION');
    }
    return {
      applicableRelationRefs: applicable.map(({ ref }) => ref),
      contextEvidenceRef: context.evidenceRef,
      outcome: 'ELIGIBLE' as const,
      positionRef: scope.positionRef,
      rule: 'POSITIVE_CURRENT_RELATION_UNION' as const,
    };
  }),
});

export const makeStockSharingEligibilityService = (dependencies: {
  readonly commerceValidator: StockSharingCommerceScopeValidator;
  readonly makeEligibilityId: () => string;
  readonly persistence: StockSharingEligibilityPersistence;
}) => {
  const { commerceValidator, makeEligibilityId, persistence } = dependencies;
  const evaluator = makeStockSharingEligibilityEvaluator(persistence);

  return {
    change: Effect.fn('StockSharingEligibilityService.change')(function* changeEligibility(
      input: ChangeStockSharingEligibilityInput,
    ) {
      const found = yield* persistence.findByRef(input.relationRef);
      const current = yield* requireCurrent(input.relationRef, found);
      if (current.ref.tenantId !== input.subject.sellingLegalEntityRef.tenantId) {
        return yield* rejected('TENANT_SCOPE_MISMATCH', current.ref);
      }
      if (current.effectivePeriod.from >= input.changedAt) {
        return yield* rejected('INVALID_LIFECYCLE_TIME', current.ref);
      }
      const commerceValidation = yield* commerceValidator.validateCurrent(
        current.scope,
        input.subject,
        input.changedAt,
      );
      const next = yield* Schema.decodeEffect(StockSharingEligibilitySchema)({
        ...current,
        commerceValidation,
        effectivePeriod: { from: input.changedAt, to: null },
        revision: current.revision + 1,
        subject: input.subject,
      }).pipe(Effect.mapError((cause) => Object.assign(rejected('INVALID_RELATION', current.ref), { cause })));
      return yield* persistence.saveRevision({ current, next });
    }),
    end: Effect.fn('StockSharingEligibilityService.end')(function* endEligibility(
      input: EndStockSharingEligibilityInput,
    ) {
      const found = yield* persistence.findByRef(input.relationRef);
      const current = yield* requireCurrent(input.relationRef, found);
      if (current.effectivePeriod.from >= input.endedAt) {
        return yield* rejected('INVALID_LIFECYCLE_TIME', current.ref);
      }
      const next = yield* Schema.decodeEffect(StockSharingEligibilitySchema)({
        ...current,
        effectivePeriod: { ...current.effectivePeriod, to: input.endedAt },
        lifecycle: 'ENDED',
        revision: current.revision + 1,
      }).pipe(Effect.mapError((cause) => Object.assign(rejected('INVALID_RELATION', current.ref), { cause })));
      return yield* persistence.saveRevision({ current, next });
    }),
    establish: Effect.fn('StockSharingEligibilityService.establish')(function* establishEligibility(
      input: EstablishStockSharingEligibilityInput,
    ) {
      const commerceValidation = yield* commerceValidator.validateCurrent(
        input.scope,
        input.subject,
        input.effectiveFrom,
      );
      const current = yield* persistence.listCurrent(input.scope);
      if (current.some((relation) => sameSubject(relation.subject, input.subject))) {
        return yield* rejected('DUPLICATE_CURRENT_RELATION');
      }
      const relation = yield* candidate(input, commerceValidation, makeEligibilityId());
      return yield* persistence.insertCurrent(relation);
    }),
    evaluate: evaluator.evaluate,
  };
};
