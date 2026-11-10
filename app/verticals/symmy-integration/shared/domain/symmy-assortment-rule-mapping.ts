import { CreateApplicabilityBindingPayloadSchema } from '@app/assortment/actions/create-applicability-binding';
import { CreateRulePayloadSchema } from '@app/assortment/actions/create-rule';
import { ImportSymmyRulePayloadSchema } from '@app/assortment/actions/import-symmy-rule';
import { qualifySymmySourceRecord, SymmySourceRecordKeySchema } from '@app/shared-contracts/symmy';
import type { SymmyRouteContext } from '@app/shared-contracts/symmy';
import { Effect, Schema } from 'effect';

import { symmySourceRecordFingerprint } from './symmy-source-record-fingerprint.ts';

export const symmyAssortmentRuleMappingVersion = 'INTERNAL_C14_ASSORTMENT_RULE_V1';
export const symmyAssortmentRuleOperation = {
  entrypointKey: 'commerce.assortment.import-symmy-rule',
  moduleId: 'commerce.assortment',
  schemaVersion: '1',
} as const;
const productSelector = Schema.Union(CreateRulePayloadSchema.fields.selector.members).pipe(Schema.toTaggedUnion('kind'))
  .cases.PRODUCT;
const customerGroupAudience = Schema.Union(CreateApplicabilityBindingPayloadSchema.fields.audience.members).pipe(
  Schema.toTaggedUnion('kind'),
).cases.COMMERCE_CUSTOMER_GROUP;

/** One explicitly declared Product rule and Customer Group binding from an internal C14 source. */
export const SymmyAssortmentRuleSourceSchema = Schema.Struct({
  audience: customerGroupAudience,
  commercialScope: CreateApplicabilityBindingPayloadSchema.fields.commercialScope,
  contractVersion: Schema.Literal(symmyAssortmentRuleMappingVersion),
  effect: CreateRulePayloadSchema.fields.effect,
  effectiveFrom: CreateApplicabilityBindingPayloadSchema.fields.effectiveFrom,
  purpose: CreateRulePayloadSchema.fields.purpose,
  reason: CreateRulePayloadSchema.fields.reason,
  selector: productSelector,
  sourceRecordId: SymmySourceRecordKeySchema.fields.sourceRecordId,
  storefrontAppId: ImportSymmyRulePayloadSchema.fields.binding.fields.storefrontAppId,
});
export const decodeSymmyAssortmentRuleSource = Schema.decodeUnknownEffect(SymmyAssortmentRuleSourceSchema, {
  onExcessProperty: 'error',
});

class SymmyAssortmentRuleMappingRejected extends Schema.TaggedError<SymmyAssortmentRuleMappingRejected>()(
  'SymmyAssortmentRuleMappingRejected',
  { reason: Schema.Literals(['route_not_allowed', 'source_scope_mismatch']) },
) {}

type MappingRoute = Pick<
  SymmyRouteContext,
  | 'allowedOwnerOperations'
  | 'factFamily'
  | 'issuerId'
  | 'mappingVersion'
  | 'route'
  | 'sellingLegalEntityId'
  | 'sourceNamespace'
>;

/** Maps one explicit rule and its binding to an atomic owner command. */
export const mapSymmyAssortmentRule = Effect.fn('SymmyAssortmentRule.map')(function* mapRule(
  route: MappingRoute,
  source: typeof SymmyAssortmentRuleSourceSchema.Type,
) {
  if (
    route.factFamily !== 'ASSORTMENT_RULE' ||
    route.mappingVersion !== symmyAssortmentRuleMappingVersion ||
    route.sellingLegalEntityId === undefined ||
    !route.allowedOwnerOperations.some(
      ({ entrypointKey, moduleId, schemaVersion }) =>
        moduleId === symmyAssortmentRuleOperation.moduleId &&
        entrypointKey === symmyAssortmentRuleOperation.entrypointKey &&
        schemaVersion === symmyAssortmentRuleOperation.schemaVersion,
    )
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
  const binding = {
    audience,
    commercialScope,
    effectiveFrom: source.effectiveFrom,
    provenanceRef,
    reason: source.reason,
  };
  if (source.storefrontAppId !== undefined) {
    Object.assign(binding, { storefrontAppId: source.storefrontAppId });
  }
  const payload = yield* Schema.decodeUnknownEffect(Schema.toType(ImportSymmyRulePayloadSchema))({
    binding,
    rule: {
      effect: source.effect,
      provenanceRef,
      purpose: source.purpose,
      reason: source.reason,
      selector,
      stableCode: `symmy-${digest}`,
    },
  });
  return { payload, record };
});
