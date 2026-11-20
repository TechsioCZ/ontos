import { Match, Schema } from 'effect';
import { SymmyDurableJobRouteKeySchema, SymmyJobIdSchema } from './symmy-job-identities.ts';
import { SymmyCustomerRowsSchema } from './symmy-customer-batch.ts';
import { SymmyGroupCustomerRowsSchema } from './symmy-customer-group-batch.ts';
import { SymmyInternalExecutionPlanSchema } from './symmy-job-execution.ts';
import { SymmyPriceBatchSchema, SymmyPriceReviseFactsListSchema } from './symmy-price-batch.ts';
import { SymmyPriceListRowsSchema } from './symmy-price-list-batch.ts';
import { SymmyProductPriceGroupFactsSchema, SymmyProductRowsSchema } from './symmy-product-batch.ts';

import { SymmyPolicyFixtureRouteKeySchema } from './symmy-policy-fixture-intents.ts';

export { SymmyJobIdSchema } from './symmy-job-identities.ts';

const SymmyFixtureIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)).pipe(
  Schema.brand('SymmyFixtureId'),
);
const SymmyClientIdempotencyKeySchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,200}$/u)).pipe(
  Schema.brand('SymmyClientIdempotencyKey'),
);

interface AdmissionFields {
  readonly code?: unknown;
  readonly contractVersion?: unknown;
  readonly customers?: unknown;
  readonly fixtureId?: unknown;
  readonly groupCustomers?: unknown;
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
const carriesNoCustomerSource = ({ customers, groupCustomers }: AdmissionFields) =>
  customers === undefined && groupCustomers === undefined;
const carriesNoFixtureSource = ({ code, contractVersion, fixtureId, plan }: AdmissionFields) =>
  code === undefined && fixtureId === undefined && contractVersion === undefined && plan === undefined;
const priceListsAdmissionValid = (fields: AdmissionFields) =>
  fields.priceLists !== undefined &&
  fields.priceBatch === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoCustomerSource(fields) &&
  carriesNoProductSource(fields) &&
  carriesNoFixtureSource(fields);
const priceBatchAdmissionValid = (fields: AdmissionFields) =>
  fields.priceBatch !== undefined &&
  fields.reviseFacts !== undefined &&
  fields.priceLists === undefined &&
  carriesNoCustomerSource(fields) &&
  carriesNoProductSource(fields) &&
  carriesNoFixtureSource(fields);
const productsAdmissionValid = (fields: AdmissionFields) =>
  fields.products !== undefined &&
  fields.priceGroupFacts !== undefined &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoCustomerSource(fields) &&
  carriesNoFixtureSource(fields);
type InternalPlan = typeof SymmyInternalExecutionPlanSchema.Type;
type InternalIntent = NonNullable<InternalPlan['items'][number]['effects'][number]['intent']>;
/**
 * The intents only the public customer group routes carry: a group definition is fenced on what the owner holds for
 * its code, and a membership takes its order from the lineage ledger. An internal plan would bypass both.
 */
const isPublicGroupRouteIntent = (intent: InternalIntent) =>
  Match.value(intent).pipe(
    Match.tag('CustomerGroupCreate', 'CustomerGroupMembership', 'CustomerGroupUpdate', () => true),
    Match.orElse(() => false),
  );
const statesPublicGroupIntent = ({ items }: InternalPlan) =>
  items.some(({ effects }) => effects.some(({ intent }) => intent !== undefined && isPublicGroupRouteIntent(intent)));
/**
 * The internal plan the selected customer group route carries: owner intents no public body states, such as a price
 * group assignment. A plan that states a customer group definition or membership is refused before admission.
 */
export const SymmyGroupRouteInternalPlanSchema = SymmyInternalExecutionPlanSchema.check(
  Schema.makeFilter(
    (plan) =>
      !statesPublicGroupIntent(plan) ||
      'A customer group definition or membership comes only through the public customer group routes',
  ),
);

const customersAdmissionValid = (fields: AdmissionFields) =>
  fields.customers !== undefined &&
  fields.groupCustomers === undefined &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoProductSource(fields) &&
  carriesNoFixtureSource(fields);
const groupCustomersAdmissionValid = (fields: AdmissionFields) =>
  fields.groupCustomers !== undefined &&
  fields.code !== undefined &&
  fields.customers === undefined &&
  fields.fixtureId === undefined &&
  fields.contractVersion === undefined &&
  fields.plan === undefined &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoProductSource(fields);
const groupPlanAdmissionValid = (fields: AdmissionFields & { readonly plan?: InternalPlan }) =>
  fields.code !== undefined &&
  fields.contractVersion === 'INTERNAL_C14' &&
  fields.plan !== undefined &&
  !statesPublicGroupIntent(fields.plan) &&
  fields.fixtureId === undefined &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.reviseFacts === undefined &&
  carriesNoCustomerSource(fields) &&
  carriesNoProductSource(fields);
const fixtureAdmissionValid = (fields: AdmissionFields) =>
  carriesNoCustomerSource(fields) &&
  carriesNoProductSource(fields) &&
  fields.priceLists === undefined &&
  fields.priceBatch === undefined &&
  fields.reviseFacts === undefined &&
  ((fields.fixtureId !== undefined && fields.contractVersion === undefined && fields.plan === undefined) ||
    (fields.fixtureId === undefined &&
      fields.contractVersion === 'INTERNAL_C14' &&
      fields.plan !== undefined &&
      !Schema.is(SymmyPolicyFixtureRouteKeySchema)(fields.routeKey))) &&
  fields.code === undefined;

export const AdmitSymmyJobPayloadSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300))),
  contractVersion: Schema.optionalKey(Schema.Literal('INTERNAL_C14')),
  /** The public customers. The route enrollment and the admission supply every owner fact the body lacks. */
  customers: Schema.optionalKey(SymmyCustomerRowsSchema),
  fixtureId: Schema.optionalKey(SymmyFixtureIdSchema),
  /** The customers of the group the code selects. The route enrollment supplies the group and every source fact. */
  groupCustomers: Schema.optionalKey(SymmyGroupCustomerRowsSchema),
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
      return priceListsAdmissionValid(fields) || 'Price lists carry no other source';
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
    if (fields.routeKey === 'customerGroupCustomersBatch') {
      return (
        groupCustomersAdmissionValid(fields) ||
        groupPlanAdmissionValid(fields) ||
        'The customer group route takes its code with its customers, or with an internal plan that states no customer group definition or membership'
      );
    }
    return (
      fixtureAdmissionValid(fields) ||
      'Fixture routes require a fixture ID and no code, and public bodies go only to their own route'
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
