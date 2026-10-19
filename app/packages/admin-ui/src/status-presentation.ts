/**
 * Status vocabulary for the Akros admin screens. Mirrors
 * `.agents/skills/ontos-dense-admin/references/status-vocabulary.md`.
 * Only the five Akros-distinct badge variants are used.
 */
import { Schema } from 'effect';

const statusKindSchema = Schema.Literals([
  'opportunity',
  'invoice',
  'payment',
  'task',
  'priority',
  'order',
  'stock-movement',
]);
export type StatusKind = typeof statusKindSchema.Type;

const statusVariantSchema = Schema.Literals(['outline', 'info', 'warning', 'success', 'danger']);
export type StatusVariant = typeof statusVariantSchema.Type;

export interface StatusPresentation {
  label: string;
  variant: StatusVariant;
}

const vocabulary = {
  invoice: {
    CONFIRMED: { label: 'Vystavená', variant: 'info' },
    DRAFT: { label: 'Koncept', variant: 'outline' },
    VOIDED: { label: 'Stornovaná', variant: 'outline' },
  },
  opportunity: {
    LEAD: { label: 'Nová', variant: 'outline' },
    LOST: { label: 'Prohraná', variant: 'danger' },
    NEGOTIATION: { label: 'Vyjednávání', variant: 'warning' },
    PROPOSAL: { label: 'Nabídka', variant: 'info' },
    QUALIFIED: { label: 'Kvalifikovaná', variant: 'info' },
    WON: { label: 'Vyhraná', variant: 'success' },
  },
  order: {
    CANCELLED: { label: 'Zrušená', variant: 'outline' },
    CONFIRMED: { label: 'Potvrzená', variant: 'info' },
    DELIVERED: { label: 'Doručená', variant: 'success' },
    NEW: { label: 'Nová', variant: 'warning' },
    PACKING: { label: 'Balí se', variant: 'info' },
    SHIPPED: { label: 'Předáno dopravci', variant: 'info' },
  },
  payment: {
    OVERDUE: { label: 'Po splatnosti', variant: 'danger' },
    PAID: { label: 'Uhrazená', variant: 'success' },
    PARTIAL: { label: 'Částečně uhrazená', variant: 'info' },
    UNPAID: { label: 'Neuhrazená', variant: 'warning' },
  },
  priority: {
    HIGH: { label: 'Vysoká', variant: 'danger' },
    LOW: { label: 'Nízká', variant: 'outline' },
    NORMAL: { label: 'Normální', variant: 'outline' },
  },
  'stock-movement': {
    ADJUSTMENT: { label: 'Inventurní úprava', variant: 'warning' },
    ISSUE: { label: 'Výdej', variant: 'info' },
    ORDER: { label: 'Objednávka', variant: 'outline' },
    RECEIPT: { label: 'Příjem', variant: 'success' },
  },
  task: {
    CANCELLED: { label: 'Zrušený', variant: 'outline' },
    DONE: { label: 'Dokončený', variant: 'success' },
    IN_PROGRESS: { label: 'Rozpracovaný', variant: 'info' },
    NEW: { label: 'Nový', variant: 'outline' },
    WAITING: { label: 'Čeká', variant: 'warning' },
  },
} satisfies Record<StatusKind, Record<string, StatusPresentation>>;

/**
 * Maps a domain status value to its Czech label and Badge variant. Unknown
 * values fall back to the raw value on an outline badge rather than rendering
 * `undefined`.
 */
export const statusPresentation = (kind: StatusKind, value: string): StatusPresentation => {
  const fallback: StatusPresentation = { label: value, variant: 'outline' };
  const entries: Partial<Record<string, StatusPresentation>> = vocabulary[kind];
  return Object.hasOwn(entries, value) ? (entries[value] ?? fallback) : fallback;
};
