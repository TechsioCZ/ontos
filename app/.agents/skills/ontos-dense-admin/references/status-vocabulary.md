# Status vocabulary: domain state → Badge variant → Czech/English label

One map per domain state machine, in one file per vertical (`src/ui/status.ts`). Every screen,
including tables, detail headers, kanban cards, charts and toasts, reads from that map. Never pick a
colour inline.

## Colour semantics under the Akros theme

Badges are solid. In Akros, only five variants are visually distinct, so use only these five:

| Variant | Akros look | Meaning |
|---|---|---|
| `outline` | grey text, no fill | not started, inactive, closed without action (draft, cancelled, voided) |
| `info` | blue solid | in progress, normal flow |
| `warning` | yellow solid | someone must act now (unpaid, waiting, new order to confirm, negotiation) |
| `success` | green solid | done, positive outcome |
| `danger` | red solid | failed, lost, overdue, high priority |

Do not use these for statuses. `secondary` is green in Akros and reads as success. `tertiary`
is the same blue as `info`. `primary` is the brand yellow and collides with `warning`. `discount`
is for prices only. `dynamic` is for tag colours only (see TagBadge).

## Maps

Opportunity stage (`příležitost`, feminine):

| Value | Variant | cs | en |
|---|---|---|---|
| LEAD | outline | Lead | Lead |
| QUALIFIED | info | Kvalifikovaná | Qualified |
| PROPOSAL | info | Nabídka | Proposal |
| NEGOTIATION | warning | Vyjednávání | Negotiation |
| WON | success | Vyhraná | Won |
| LOST | danger | Prohraná | Lost |

Invoice status (`faktura`, feminine):

| Value | Variant | cs | en |
|---|---|---|---|
| DRAFT | outline | Koncept | Draft |
| CONFIRMED | info | Vystavená | Issued |
| VOIDED | outline | Stornovaná | Voided |

Invoice payment:

| Value | Variant | cs | en |
|---|---|---|---|
| UNPAID | warning | Neuhrazená | Unpaid |
| PARTIAL | info | Částečně uhrazená | Partially paid |
| PAID | success | Uhrazená | Paid |
| *(derived)* UNPAID or PARTIAL with `dueDate < today` | danger | Po splatnosti | Overdue |

Task status (`úkol`, masculine):

| Value | Variant | cs | en |
|---|---|---|---|
| NEW | outline | Nový | New |
| IN_PROGRESS | info | Rozpracovaný | In progress |
| WAITING | warning | Čeká | Waiting |
| DONE | success | Dokončený | Done |
| CANCELLED | outline | Zrušený | Cancelled |

Task priority (`priorita`, feminine):

| Value | Variant | cs | en |
|---|---|---|---|
| LOW | outline | Nízká | Low |
| NORMAL | outline | Normální | Normal |
| HIGH | danger | Vysoká | High |

Order status (`objednávka`, feminine):

| Value | Variant | cs | en |
|---|---|---|---|
| NEW | warning | Nová | New |
| CONFIRMED | info | Potvrzená | Confirmed |
| SHIPPED | info | Odeslaná | Shipped |
| DELIVERED | success | Doručená | Delivered |
| CANCELLED | outline | Zrušená | Cancelled |

Stock movement type (`pohyb`, masculine). This is a type, not a lifecycle, and it always comes with a signed quantity:

| Value | Variant | cs | en | Quantity cell |
|---|---|---|---|---|
| RECEIPT | success | Příjem | Receipt | `+12` |
| ISSUE | info | Výdej | Issue | `−5` |
| ADJUSTMENT | warning | Inventurní úprava | Adjustment | `+2` / `−3` |
| ORDER | outline | Objednávka | Order | `−4` |

Quantities use `Intl.NumberFormat(locale, { signDisplay: 'exceptZero' })`, are end-aligned and use
`tabular-nums`. Do not rely on red or green text alone, because the sign carries the meaning.

## Code: `src/ui/status.ts` (copy the maps your vertical needs)

```ts
type Variant = 'outline' | 'info' | 'warning' | 'success' | 'danger';
type StatusMeta = { variant: Variant; labelKey: string };

const meta = <K extends string>(prefix: string, variants: Record<K, Variant>) =>
  Object.fromEntries(
    Object.entries(variants).map(([key, variant]) => [key, { variant, labelKey: `${prefix}.${key}` }]),
  ) as Record<K, StatusMeta>;

export const opportunityStage = meta('status.opportunity', {
  LEAD: 'outline', QUALIFIED: 'info', PROPOSAL: 'info', NEGOTIATION: 'warning', WON: 'success', LOST: 'danger',
});
export const invoiceStatus = meta('status.invoice', { DRAFT: 'outline', CONFIRMED: 'info', VOIDED: 'outline' });
export const paymentStatus = meta('status.payment', {
  UNPAID: 'warning', PARTIAL: 'info', PAID: 'success', OVERDUE: 'danger',
});
export const taskStatus = meta('status.task', {
  NEW: 'outline', IN_PROGRESS: 'info', WAITING: 'warning', DONE: 'success', CANCELLED: 'outline',
});
export const taskPriority = meta('status.priority', { LOW: 'outline', NORMAL: 'outline', HIGH: 'danger' });
export const orderStatus = meta('status.order', {
  NEW: 'warning', CONFIRMED: 'info', SHIPPED: 'info', DELIVERED: 'success', CANCELLED: 'outline',
});
export const stockMovement = meta('status.movement', {
  RECEIPT: 'success', ISSUE: 'info', ADJUSTMENT: 'warning', ORDER: 'outline',
});

/** Overdue is derived in the UI, never stored. */
export const effectivePayment = (payment: 'UNPAID' | 'PARTIAL' | 'PAID', dueDate: string, today = new Date()) =>
  payment !== 'PAID' && new Date(dueDate) < today ? 'OVERDUE' : payment;
```

Render:

```tsx
import { Badge } from '@techsio/ui-kit/atoms/badge';

function StateBadge({ meta }: { meta: { variant: Variant; labelKey: string } }) {
  const { t } = useModernI18n();           // from '@modern-js/plugin-i18n/runtime'
  return <Badge size="sm" variant={meta.variant}>{t(meta.labelKey)}</Badge>;
}
// <StateBadge meta={opportunityStage[row.stage]} />
```

If `@ontos/admin-ui`'s `StatusBadge` accepts `{ variant, label }` (check its props in
`app/packages/admin-ui/src`), use it instead of the local `StateBadge`. The variants above still apply.

Locale fragment, `locales/cs/<vertical>.json` (include only the maps you use):

```json
{
  "status": {
    "opportunity": { "LEAD": "Lead", "QUALIFIED": "Kvalifikovaná", "PROPOSAL": "Nabídka", "NEGOTIATION": "Vyjednávání", "WON": "Vyhraná", "LOST": "Prohraná" },
    "invoice": { "DRAFT": "Koncept", "CONFIRMED": "Vystavená", "VOIDED": "Stornovaná" },
    "payment": { "UNPAID": "Neuhrazená", "PARTIAL": "Částečně uhrazená", "PAID": "Uhrazená", "OVERDUE": "Po splatnosti" },
    "task": { "NEW": "Nový", "IN_PROGRESS": "Rozpracovaný", "WAITING": "Čeká", "DONE": "Dokončený", "CANCELLED": "Zrušený" },
    "priority": { "LOW": "Nízká", "NORMAL": "Normální", "HIGH": "Vysoká" },
    "order": { "NEW": "Nová", "CONFIRMED": "Potvrzená", "SHIPPED": "Odeslaná", "DELIVERED": "Doručená", "CANCELLED": "Zrušená" },
    "movement": { "RECEIPT": "Příjem", "ISSUE": "Výdej", "ADJUSTMENT": "Inventurní úprava", "ORDER": "Objednávka" }
  }
}
```

## Tags

Tags are not statuses. Render them with `TagBadge` from `@ontos/admin-ui` (outline, or `dynamic`
with the tag's stored colour). Show at most 3 tags in a table cell, then `+2`, as an outline Badge with a
Tooltip that lists the rest. Never map a tag to `success`, `warning` or `danger`.

## Filters

DataTable enum filters reuse the same maps: `meta: { type: 'enum', options: Object.keys(opportunityStage).map((v) => ({ value: v, label: t(opportunityStage[v].labelKey) })) }`.
