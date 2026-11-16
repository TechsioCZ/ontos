import { Schema } from 'effect';
import { SymmyDurableJobRouteKeySchema, SymmyJobIdSchema } from './symmy-job-identities.ts';
import { SymmyCustomerRowsSchema } from './symmy-customer-batch.ts';
import { SymmyInternalExecutionPlanSchema } from './symmy-job-execution.ts';
import { SymmyPriceBatchSchema, SymmyPriceReviseFactsListSchema } from './symmy-price-batch.ts';
import { SymmyCatalogHeadSchema, SymmyPriceListRowsSchema } from './symmy-price-list-batch.ts';
import { SymmyProductPriceGroupFactsSchema, SymmyProductRowsSchema } from './symmy-product-batch.ts';

import { SymmyPolicyFixtureRouteKeySchema } from './symmy-policy-fixture-intents.ts';

export { SymmyJobIdSchema } from './symmy-job-identities.ts';

const codedRoutes = Schema.Literal('customerGroupCustomersBatch');
const SymmyFixtureIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)).pipe(
  Schema.brand('SymmyFixtureId'),
);
const SymmyClientIdempotencyKeySchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,200}$/u)).pipe(
  Schema.brand('SymmyClientIdempotencyKey'),
);

interface AdmissionFields {
  readonly catalogHead?: unknown;
  readonly code?: unknown;
  readonly contractVersion?: unknown;
  readonly customers?: unknown;
  readonly fixtureId?: unknown;
  readonly plan?: unknown;
  readonly priceBatch?: unknown;
  readonly priceGroupFacts?: unknown;
  readonly priceLists?: unknown;
  readonly products?: unknown;
  readonly reviseFacts?: unknown;
  readonly routeKey: string;
}
const carriesNoProductSource = ({ priceGroupFacts, products }: AdmissionFields) =>
  products === undefined && priceGroupFacts === undefined;
const carriesNoCustomerSource = ({ customers }: AdmissionFields) => customers === undefined;
const carriesNoFixtureSource = ({ code, contractVersion, fixtureId, plan }: AdmissionFields) =>
  code === undefined && fixtureId === undefined && contractVersion === undefined && plan === undefined;
const priceListsAdmissionValid = (fields: AdmissionFields) =>
  fields.priceLists !== undefined &&
  fields.catalogHead !== undefined &&
  fields.priceBatch === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoCustomerSource(fields) &&
  carriesNoProductSource(fields) &&
  carriesNoFixtureSource(fields);
const priceBatchAdmissionValid = (fields: AdmissionFields) =>
  fields.priceBatch !== undefined &&
  fields.reviseFacts !== undefined &&
  fields.priceLists === undefined &&
  fields.catalogHead === undefined &&
  carriesNoCustomerSource(fields) &&
  carriesNoProductSource(fields) &&
  carriesNoFixtureSource(fields);
const productsAdmissionValid = (fields: AdmissionFields) =>
  fields.products !== undefined &&
  fields.priceGroupFacts !== undefined &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.catalogHead === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoCustomerSource(fields) &&
  carriesNoFixtureSource(fields);
const customersAdmissionValid = (fields: AdmissionFields) =>
  fields.customers !== undefined &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.catalogHead === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoProductSource(fields) &&
  carriesNoFixtureSource(fields);
const fixtureAdmissionValid = (fields: AdmissionFields) =>
  carriesNoCustomerSource(fields) &&
  carriesNoProductSource(fields) &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.catalogHead === undefined &&
  fields.reviseFacts === undefined &&
  ((fields.fixtureId !== undefined && fields.contractVersion === undefined && fields.plan === undefined) ||
    (fields.fixtureId === undefined &&
      fields.contractVersion === 'INTERNAL_C14' &&
      fields.plan !== undefined &&
      !Schema.is(SymmyPolicyFixtureRouteKeySchema)(fields.routeKey))) &&
  Schema.is(codedRoutes)(fields.routeKey) === (fields.code !== undefined);

export const AdmitSymmyJobPayloadSchema = Schema.Struct({
  /** The tenant catalog head read for the request. It fences the first created price list and is not caller intent. */
  catalogHead: Schema.optionalKey(SymmyCatalogHeadSchema),
  code: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300))),
  contractVersion: Schema.optionalKey(Schema.Literal('INTERNAL_C14')),
  /** The public customers. The route enrollment and the admission supply every owner fact the body lacks. */
  customers: Schema.optionalKey(SymmyCustomerRowsSchema),
  fixtureId: Schema.optionalKey(SymmyFixtureIdSchema),
  idempotencyKey: SymmyClientIdempotencyKeySchema,
  plan: Schema.optionalKey(SymmyInternalExecutionPlanSchema),
  /** The public price batch: one price list and its DEFINE and REVISE items. */
  priceBatch: Schema.optionalKey(SymmyPriceBatchSchema),
  /** The price list each price group code of the products names, read for the route. Never caller intent. */
  priceGroupFacts: Schema.optionalKey(SymmyProductPriceGroupFactsSchema),
  /** The public price list rows. The route enrollment, not the caller, supplies every other price fact. */
  priceLists: Schema.optionalKey(SymmyPriceListRowsSchema),
  /** The public products. The route enrollment and the admission supply every owner fact the body lacks. */
  products: Schema.optionalKey(SymmyProductRowsSchema),
  /** What the owner already holds about each REVISE price, read now. It is a fence, never caller intent. */
  reviseFacts: Schema.optionalKey(SymmyPriceReviseFactsListSchema),
  routeKey: SymmyDurableJobRouteKeySchema,
}).check(
  Schema.makeFilter((fields) => {
    if (fields.routeKey === 'priceListsBatchUpsert') {
      return priceListsAdmissionValid(fields) || 'Price lists need the catalog head and no other source';
    }
    if (fields.routeKey === 'customersBatch' && fields.customers !== undefined) {
      return customersAdmissionValid(fields) || 'Customers carry no other source';
    }
    if (fields.routeKey === 'productsBatch') {
      return (
        productsAdmissionValid(fields) ||
        'Products need their price group facts and no other source, and the products route takes nothing else'
      );
    }
    if (fields.routeKey === 'priceListPricesBatch') {
      return priceBatchAdmissionValid(fields) || 'A price batch needs its REVISE facts and no other source';
    }
    return (
      fixtureAdmissionValid(fields) ||
      'Fixture routes require a fixture ID, only the customer group route requires a code, and public bodies go only to their own route'
    );
  }),
);
export type AdmitSymmyJobPayload = typeof AdmitSymmyJobPayloadSchema.Type;

export const AdmitSymmyJobResultSchema = Schema.Struct({
  jobId: SymmyJobIdSchema,
  phase: Schema.Literal('admitted'),
});

export class AdmitSymmyJobRejected extends Schema.TaggedError<AdmitSymmyJobRejected>()('AdmitSymmyJobRejected', {
  code: Schema.Literals(['symmy_job_intent_conflict', 'symmy_job_persistence_unavailable', 'symmy_job_route_denied']),
  reason: Schema.String,
}) {}
