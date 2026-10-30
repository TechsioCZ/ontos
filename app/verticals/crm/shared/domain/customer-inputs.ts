// AREA: customer inputs (CRM.md §6, R01–R08). Register of what the customer still has to supply or decide: what is
// missing, who asked for it and when, what exactly it blocks, the evidence of the request and its state. A delivered
// sample keeps its schema version and approval date. R04 approval of the status mapping is what switches the sales
// report from raw statuses to business meanings (C03/C05: "storno / dodáno / uhrazeno" only after confirmation).
// Adding fields: make them Schema.optionalKey (persisted JSON from older revisions must still decode).
import { Schema } from 'effect';
import { CalendarDateSchema, IsoTimeSchema, LongTextSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

export const customerInputIds = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08'] as const;
export const CustomerInputIdSchema = Schema.Literals(customerInputIds);
export type CustomerInputId = typeof CustomerInputIdSchema.Type;

export const CustomerInputStatusSchema = Schema.Literals(['requested', 'received', 'approved', 'not_needed']);

/** One state change of an input, newest last. */
export const CustomerInputChangeSchema = Schema.Struct({
  at: IsoTimeSchema,
  by: PrincipalIdSchema,
  note: Schema.optionalKey(LongTextSchema),
  status: CustomerInputStatusSchema,
});

export const CustomerInputSchema = Schema.Struct({
  /** Evidence of the request (document, e-mail, meeting minutes). */
  evidence: LongTextSchema,
  history: Schema.Array(CustomerInputChangeSchema),
  id: CustomerInputIdSchema,
  note: Schema.optionalKey(LongTextSchema),
  /** Calendar day the input was requested (YYYY-MM-DD). */
  requestedAt: CalendarDateSchema,
  requestedBy: ShortTextSchema,
  /** Calendar day the customer approved the delivered sample / rule. */
  sampleApprovedAt: Schema.optionalKey(CalendarDateSchema),
  /** Schema / template / mapping version of the delivered sample, e.g. "crm-orders-csv-v1", "stavy-v1". */
  sampleVersion: Schema.optionalKey(ShortTextSchema),
  status: CustomerInputStatusSchema,
  updatedAt: Schema.optionalKey(IsoTimeSchema),
  updatedBy: Schema.optionalKey(PrincipalIdSchema),
});
export type CustomerInput = typeof CustomerInputSchema.Type;

/** Persisted entries only; inputs nobody has touched yet come from the defaults below. */
export const CustomerInputsSliceSchema = Schema.Array(CustomerInputSchema);
export type CustomerInputsSlice = typeof CustomerInputsSliceSchema.Type;

/** Version of the status mapping proposal and of the CSV template the demo offers for approval. */
export const proposedSampleVersions = new Map([
  ['R01', 'crm-orders-csv-v1'],
  ['R04', 'stavy-v1'],
]);

/** Every input was requested with the demo assignment of 19. 10. 2026 (CRM.md §6 and §10). */
const defaultInput = (id: CustomerInputId): CustomerInput => {
  const result: CustomerInput = {
    evidence: 'Zadání CRM dema, kap. 6 „Co zákazník musí dodat / rozhodnout“ (19. 10. 2026)',
    history: [],
    id,
    requestedAt: CalendarDateSchema.make('2026-10-19'),
    requestedBy: 'Techsio – dodavatel dema',

    status: 'requested',
  };
  const sampleVersion = proposedSampleVersions.get(id);
  if (sampleVersion !== undefined) {
    Object.assign(result, { sampleVersion });
  }
  return result;
};

export const customerInputOf = (slice: CustomerInputsSlice | undefined, id: CustomerInputId): CustomerInput =>
  slice?.find((entry) => entry.id === id) ?? defaultInput(id);

/**
 * True only when the customer approved R04 for exactly this mapping version. Until then the report shows raw
 * statuses only and never counts "stornované / dodané / uhrazené" (C03, C05).
 */
export const statusMappingApproved = (slice: CustomerInputsSlice | undefined, mappingVersion: string): boolean => {
  const input = customerInputOf(slice, 'R04');
  return input.status === 'approved' && input.sampleVersion === mappingVersion && input.sampleApprovedAt !== undefined;
};
