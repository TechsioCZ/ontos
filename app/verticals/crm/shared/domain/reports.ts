// AREA: reports (C05) — owned by the crm-reports lane. Read-only aggregation over the projected state the read
// server returns (so a salesperson's report and CSV never contain other salespeople's clients, C05-04).
// No commands. Put pure aggregation helpers here; pages live under src/routes/[lang]/crm/prehled-prodeju.
import type { CrmState } from './state.ts';

/** Orders that count into confirmed figures: paired, not a duplicate. */
export const confirmedOrders = (state: CrmState) =>
  state.imports.orders.filter((order) => order.pairing === 'paired' && order.duplicateOf === undefined);
