import { Schema } from 'effect';

const ResourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('CommerceMarketResourceId'),
  Schema.decodeTo(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
);
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CommerceMarketTenantId'),
  Schema.decodeTo(Schema.String.check(Schema.isUUID())),
);

/** Public structural identity of the Market owner resource; no Market deployment dependency. */
export const MarketRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.market-catalog'),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('commerce.market-catalog.market'),
  tenantId: TenantIdSchema,
});
