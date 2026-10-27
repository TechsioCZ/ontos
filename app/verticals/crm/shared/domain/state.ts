// The whole CRM aggregate: one JSONB document per (tenant, legal entity). Owned by crm-scaffold.
// Each area owns its slice schema in ./<area>.ts; this file only composes them.
import { Option, Schema } from 'effect';
import type { CrmViewer } from './access.ts';
import { AiChangesSliceSchema, projectAiChangesSlice } from './ai-changes.ts';
import { ClientsSliceSchema, initialClientsSlice, projectClientsSlice, visibleClientIds } from './clients.ts';
import { CustomerInputsSliceSchema } from './customer-inputs.ts';
import { ImportsSliceSchema, initialImportsSlice, projectImportsSlice } from './imports.ts';
import { SalespersonSchema } from './team.ts';
import { VisitsSliceSchema, initialVisitsSlice, projectVisitsSlice } from './visits.ts';

export const CrmStateSchema = Schema.Struct({
  /** AI level C proposals, decisions and revert log (ai-level-c lane); absent in older documents. */
  aiChanges: Schema.optionalKey(AiChangesSliceSchema),
  clients: ClientsSliceSchema,
  /** R01–R08 register of customer inputs (CRM.md §6); absent = every input still requested. */
  customerInputs: Schema.optionalKey(CustomerInputsSliceSchema),
  imports: ImportsSliceSchema,
  salespeople: Schema.Array(SalespersonSchema),
  visits: VisitsSliceSchema,
});
export type CrmState = typeof CrmStateSchema.Type;
export type CrmStateInput = typeof CrmStateSchema.Encoded;

export const initialCrmState: CrmState = {
  clients: initialClientsSlice,
  imports: initialImportsSlice,
  salespeople: [],
  visits: initialVisitsSlice,
};

/** The JSON document boundary owns the keys; slice values are checked by CrmStateSchema after defaults. */
const StoredSlicesSchema = Schema.Struct({
  aiChanges: Schema.optionalKey(Schema.Unknown),
  clients: Schema.optionalKey(Schema.Unknown),
  customerInputs: Schema.optionalKey(Schema.Unknown),
  imports: Schema.optionalKey(Schema.Unknown),
  salespeople: Schema.optionalKey(Schema.Unknown),
  visits: Schema.optionalKey(Schema.Unknown),
});
const DefaultedSlicesSchema = Schema.Struct({
  aiChanges: Schema.optionalKey(Schema.Unknown),
  clients: Schema.Unknown,
  customerInputs: Schema.optionalKey(Schema.Unknown),
  imports: Schema.Unknown,
  salespeople: Schema.Unknown,
  visits: Schema.Unknown,
});
type DefaultedSlices = typeof DefaultedSlicesSchema.Type;

/** Fill slices missing from older persisted documents before decoding. */
export const withDefaultSlices = (raw: unknown): DefaultedSlices => {
  const value = Option.getOrElse(
    Schema.decodeUnknownOption(StoredSlicesSchema)(raw),
    (): typeof StoredSlicesSchema.Type => ({}),
  );
  const result: DefaultedSlices = {
    clients: value.clients ?? initialClientsSlice,
    imports: value.imports ?? initialImportsSlice,
    salespeople: value.salespeople ?? [],
    visits: value.visits ?? initialVisitsSlice,
  };
  if (value.aiChanges !== undefined) {
    Object.assign(result, { aiChanges: value.aiChanges });
  }
  if (value.customerInputs !== undefined) {
    Object.assign(result, { customerInputs: value.customerInputs });
  }
  return result;
};

/** What one viewer may read. The read server returns only this. */
export const projectCrmState = (state: CrmState, viewer: CrmViewer): CrmState => {
  const visible = visibleClientIds(state.clients, viewer);
  const projected: CrmState = {
    aiChanges: projectAiChangesSlice(state.aiChanges, viewer),
    clients: projectClientsSlice(state.clients, visible),
    // Not client data: every CRM user sees which customer inputs block what (and the report needs R04).
    imports: projectImportsSlice(state.imports, visible, viewer),
    salespeople: state.salespeople,
    visits: projectVisitsSlice(state.visits, visible),
  };
  if (state.customerInputs !== undefined) {
    Object.assign(projected, { customerInputs: state.customerInputs });
  }
  return projected;
};
