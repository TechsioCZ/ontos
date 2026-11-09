import { CreateApplicabilityBindingPayloadSchema } from '@app/assortment/actions/create-applicability-binding';
import { CreateRulePayloadSchema } from '@app/assortment/actions/create-rule';
import type { CreateRuleResultSchema } from '@app/assortment/actions/create-rule';
import { qualifySymmySourceRecord, SymmySourceRecordKeySchema } from '@app/shared-contracts/symmy';
import type { SymmyRouteContext } from '@app/shared-contracts/symmy';
import { Effect, Schema } from 'effect';

import { symmySourceRecordFingerprint } from './symmy-source-record-fingerprint.ts';

const mappingVersion = 'INTERNAL_C14_ASSORTMENT_RULE_V1';
const createRuleOperation = 'commerce.assortment.create-rule';
const createBindingOperation = 'commerce.assortment.create-applicability-binding';
const productSelector = Schema.Union(CreateRulePayloadSchema.fields.selector.members).pipe(Schema.toTaggedUnion('kind'))
  .cases.PRODUCT;
const customerGroupAudience = Schema.Union(CreateApplicabilityBindingPayloadSchema.fields.audience.members).pipe(
  Schema.toTaggedUnion('kind'),
).cases.COMMERCE_CUSTOMER_GROUP;

/** One explicitly declared Product rule and Customer Group binding from an internal C14 source. */
const SymmyAssortmentRuleSourceSchema = Schema.Struct({
  audience: customerGroupAudience,
  commercialScope: CreateApplicabilityBindingPayloadSchema.fields.commercialScope,
  contractVersion: Schema.Literal(mappingVersion),
  effect: CreateRulePayloadSchema.fields.effect,
  effectiveFrom: CreateApplicabilityBindingPayloadSchema.fields.effectiveFrom,
  purpose: CreateRulePayloadSchema.fields.purpose,
  reason: CreateRulePayloadSchema.fields.reason,
  selector: productSelector,
  sourceRecordId: SymmySourceRecordKeySchema.fields.sourceRecordId,
});
export const decodeSymmyAssortmentRuleSource = Schema.decodeUnknownEffect(SymmyAssortmentRuleSourceSchema, {
  onExcessProperty: 'error',
});

class SymmyAssortmentRuleMappingRejected extends Schema.TaggedError<SymmyAssortmentRuleMappingRejected>()(
  'SymmyAssortmentRuleMappingRejected',
  { reason: Schema.Literals(['route_not_allowed', 'source_scope_mismatch', 'rule_receipt_scope_mismatch']) },
) {}

/** Prepares the ordered owner calls. The mapping cannot grant either Action permission. */
export const mapSymmyAssortmentRule = Effect.fn('SymmyAssortmentRule.map')(function* mapRule(
  route: SymmyRouteContext,
  source: typeof SymmyAssortmentRuleSourceSchema.Type,
) {
  const allows = (entrypointKey: string) =>
    route.allowedOwnerOperations.some(
      (operation) =>
        operation.moduleId === 'commerce.assortment' &&
        operation.entrypointKey === entrypointKey &&
        operation.schemaVersion === '1',
    );
  if (
    route.factFamily !== 'ASSORTMENT_RULE' ||
    route.mappingVersion !== mappingVersion ||
    route.sellingLegalEntityId === undefined ||
    !allows(createRuleOperation) ||
    !allows(createBindingOperation)
  ) {
    return yield* new SymmyAssortmentRuleMappingRejected({ reason: 'route_not_allowed' });
  }

  const { audience, commercialScope, selector } = source;
  const tenantId: string = route.route.tenantId;
  const sellerId: string = route.sellingLegalEntityId;
  const refs = [
    selector.productRef,
    audience.groupRef,
    commercialScope.sellingLegalEntityRef,
    commercialScope.channelRef,
    commercialScope.commerceMarketRef,
    commercialScope.storefrontRef,
  ];
  if (
    commercialScope.sellingLegalEntityRef.resourceId !== sellerId ||
    commercialScope.sellingLegalEntityRef.moduleId !== 'party.registry' ||
    commercialScope.sellingLegalEntityRef.resourceType !== 'party.registry.legal-entity' ||
    commercialScope.commerceMarketRef === undefined ||
    commercialScope.storefrontRef === undefined ||
    selector.productRef.moduleId !== 'commerce.catalog' ||
    selector.productRef.resourceType !== 'commerce.catalog.product' ||
    refs.some((ref) => ref !== undefined && ref.tenantId !== tenantId)
  ) {
    return yield* new SymmyAssortmentRuleMappingRejected({ reason: 'source_scope_mismatch' });
  }

  const record = qualifySymmySourceRecord(route, {
    entityKind: 'ASSORTMENT_RULE',
    sourceRecordId: source.sourceRecordId,
  });
  const digest = symmySourceRecordFingerprint(record);
  const provenanceRef = `internal-c14-assortment:${digest}`;
  const rule = yield* Schema.decodeUnknownEffect(Schema.toType(CreateRulePayloadSchema))({
    effect: source.effect,
    provenanceRef,
    purpose: source.purpose,
    reason: source.reason,
    selector,
    stableCode: `symmy-${digest}`,
  });

  // The caller must supply the receipt of this plan's exact Create Rule attempt.
  const binding = Effect.fn('SymmyAssortmentRule.bindRevision')(function* bindRevision(
    receipt: typeof CreateRuleResultSchema.Type,
  ) {
    if (receipt.stableRuleRef.tenantId !== tenantId || receipt.initialRuleRevisionRef.sourceRef.tenantId !== tenantId) {
      return yield* new SymmyAssortmentRuleMappingRejected({ reason: 'rule_receipt_scope_mismatch' });
    }
    return yield* Schema.decodeUnknownEffect(Schema.toType(CreateApplicabilityBindingPayloadSchema))({
      audience,
      commercialScope,
      effectiveFrom: source.effectiveFrom,
      provenanceRef,
      reason: source.reason,
      ruleRevisionRef: receipt.initialRuleRevisionRef,
    });
  });

  return { binding, record, rule };
});
