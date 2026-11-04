import { Config, Effect, Schema } from 'effect';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const customerContextApp = 'commerce-customer-context';
const marketCatalogApp = 'commerce-market-catalog';
export const GatewayRelaySourceBindingSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  providerKeyId: nonEmpty.pipe(Schema.brand('GatewayRelaySourceCredentialId')),
  sourceAppId: Schema.Literals(['catalog', customerContextApp, marketCatalogApp]),
  sourceBuildMarker: nonEmpty,
});
const bindingsSchema = Schema.Array(GatewayRelaySourceBindingSchema).check(
  Schema.makeFilter((bindings) =>
    new Set(bindings.map((binding) => binding.providerKeyId)).size === bindings.length
      ? undefined
      : 'Source credentials must have one deployment binding',
  ),
);
export class GatewayRelayPolicyUnavailable extends Schema.TaggedError<GatewayRelayPolicyUnavailable>()(
  'GatewayRelayPolicyUnavailable',
  { cause: Schema.Defect() },
) {}
/** Issuer-owned deployment credential enrollment; request headers cannot supply this mapping. */
export const loadGatewayRelaySourceBindings = Config.schema(
  Schema.fromJsonString(bindingsSchema),
  'ONTOS_GATEWAY_RELAY_SOURCE_BINDINGS',
).pipe(Effect.mapError((cause) => new GatewayRelayPolicyUnavailable({ cause })));

/** The approved tenant-only target; callers cannot request scope projection. */
export const isCustomerContextPriceGroupCompatibilityRelay = (
  source: { readonly aud: string },
  target: { readonly audience: string; readonly operationKey: string },
): boolean =>
  source.aud === customerContextApp &&
  target.audience === 'price-group-catalog' &&
  target.operationKey === 'pricing.price-group-catalog.api.validate-price-group-compatibility';

export const permitsGatewayRelay = (
  verifiedProviderKeyId: string,
  binding: {
    readonly compositionRevision: string;
    readonly providerKeyId: string;
    readonly sourceAppId: string;
    readonly sourceBuildMarker: string;
  },
  source: { readonly aud: string; readonly compositionRevision: string; readonly targetBuildMarker: string },
  target: { readonly audience: string; readonly compositionRevision: string; readonly operationKey: string },
): boolean => {
  if (
    binding.providerKeyId !== verifiedProviderKeyId ||
    binding.sourceAppId !== source.aud ||
    binding.sourceBuildMarker !== source.targetBuildMarker ||
    binding.compositionRevision !== source.compositionRevision ||
    target.compositionRevision !== source.compositionRevision
  ) {
    return false;
  }
  if (source.aud === 'catalog') {
    return target.audience === 'party-registry' && target.operationKey === 'party.registry.api.party-detail';
  }
  if (source.aud === marketCatalogApp) {
    if (target.audience === 'storefront-registry') {
      return target.operationKey === 'commerce.storefront-registry.api.current-storefront-application';
    }
    return (
      target.audience === customerContextApp &&
      [
        'commerce.customer-context.api.market-affected-use-assessment',
        'commerce.customer-context.api.market-subject-restrictions-current',
        'commerce.customer-context.reserve-market-retirement',
        'commerce.customer-context.api.market-retirement-reservation-recovery',
      ].includes(target.operationKey)
    );
  }
  if (source.aud !== customerContextApp) {
    return false;
  }
  if (isCustomerContextPriceGroupCompatibilityRelay(source, target)) {
    return true;
  }
  if (target.audience === 'party-registry') {
    return [
      'party.registry.api.party-detail',
      'party.registry.api.guest-party-resolution',
      'party.registry.api.party-contact-point-detail',
    ].includes(target.operationKey);
  }
  return (
    target.audience === marketCatalogApp &&
    [
      'commerce.market-catalog.api.eligible-market-tuples',
      'commerce.market-catalog.api.resolve-commerce-market',
    ].includes(target.operationKey)
  );
};
