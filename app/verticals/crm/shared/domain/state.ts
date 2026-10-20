// The whole CRM aggregate: one JSONB document per (tenant, legal entity). Owned by crm-scaffold.
// Each area owns its slice schema in ./<area>.ts; this file only composes them.
import { Schema } from 'effect';
import type { CrmViewer } from './access.ts';
import { AiChangesSliceSchema, projectAiChangesSlice } from './ai-changes.ts';
import { ClientsSliceSchema, initialClientsSlice, projectClientsSlice, visibleClientIds } from './clients.ts';
import { ImportsSliceSchema, initialImportsSlice, projectImportsSlice } from './imports.ts';
import { SalespersonSchema } from './team.ts';
import { VisitsSliceSchema, initialVisitsSlice, projectVisitsSlice } from './visits.ts';

export const CrmStateSchema = Schema.Struct({
  /** AI level C proposals, decisions and revert log (ai-level-c lane); absent in older documents. */
  aiChanges: Schema.optionalKey(AiChangesSliceSchema),
  clients: ClientsSliceSchema,
  imports: ImportsSliceSchema,
  salespeople: Schema.Array(SalespersonSchema),
  visits: VisitsSliceSchema,
});
export type CrmState = typeof CrmStateSchema.Type;

export const initialCrmState: CrmState = {
  clients: initialClientsSlice,
  imports: initialImportsSlice,
  salespeople: [],
  visits: initialVisitsSlice,
};

/** Fill slices missing from older persisted documents before decoding. */
export const withDefaultSlices = (raw: unknown): unknown => {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    ...(value['aiChanges'] === undefined ? {} : { aiChanges: value['aiChanges'] }),
    clients: value['clients'] ?? initialClientsSlice,
    imports: value['imports'] ?? initialImportsSlice,
    salespeople: value['salespeople'] ?? [],
    visits: value['visits'] ?? initialVisitsSlice,
  };
};

/** What one viewer may read. The read server returns only this. */
export const projectCrmState = (state: CrmState, viewer: CrmViewer): CrmState => {
  const visible = visibleClientIds(state.clients, viewer);
  return {
    aiChanges: projectAiChangesSlice(state.aiChanges, viewer),
    clients: projectClientsSlice(state.clients, visible),
    imports: projectImportsSlice(state.imports, visible, viewer),
    salespeople: state.salespeople,
    visits: projectVisitsSlice(state.visits, visible),
  };
};
