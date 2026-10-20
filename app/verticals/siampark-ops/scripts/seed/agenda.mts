// Seed of agenda `agenda` for Siampark (legal entity …0021). OWNED BY THE `agenda` LANE (ops-agenda).
// Returns the ENCODED state with fixed ids/timestamps so reseeds are deterministic.
// Only OWN calendar entries live here (meetings, reminders, internal deadlines). Contract, lease, task, invoice,
// asset and inspection deadlines are never copied: the calendar reads them from their source module.
// Property refs are the ids the live rental seed produced (same snapshots as the security seed).
import type { AgendaStateEncoded } from '../../shared/domain/agenda.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };
const finance = { principalId: '72000000-0000-4000-8000-000000000023', tenantId };

const riverside = { id: '6a0197b3-4b13-46c5-a3ab-8dbb46dda58e', kind: 'property', label: 'Riverside Office Park (RIVERSIDE)' } as const;
const parkova = { id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b', kind: 'property', label: 'Rezidence Parková (PARKOVA)' } as const;
const r201 = { id: 'ec2c089a-69d4-459d-a67f-83d986add5f8', kind: 'unit', label: 'Riverside Office Park › Kancelář R201 (R201)' } as const;
const s01 = { id: '1ecbca7a-0c49-49c3-a122-3d0d03476cad', kind: 'unit', label: 'Riverside Office Park › Sklad S01 (S01)' } as const;

const eventId = (n: number) => `73130000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const notificationId = (n: number) => `73130000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const createdAt = '2026-10-19T07:30:00.000Z';

const audit = (by = management) => ({ createdAt, createdBy: by, updatedAt: createdAt, updatedBy: by });

const labels = new Map([
  [operations.principalId, 'operations@siampark.demo'],
  [finance.principalId, 'finance@siampark.demo'],
  [management.principalId, 'management@siampark.demo'],
]);

const events = [
  {
    ...audit(),
    assignee: operations,
    date: '2026-10-22',
    id: eventId(1),
    kind: 'MEETING',
    note: 'Obchůzka společných prostor s facility managerem, kontrola úklidu a osvětlení.',
    related: riverside,
    title: 'Kontrolní den – Riverside Office Park',
  },
  {
    ...audit(),
    assignee: operations,
    date: '2026-10-27',
    id: eventId(2),
    kind: 'INSPECTION',
    note: 'Pravidelná roční kontrola hasicích přístrojů a hydrantů (dodavatel PYRO Servis).',
    related: parkova,
    title: 'Kontrola hasicích přístrojů – Rezidence Parková',
  },
  {
    ...audit(),
    date: '2026-10-31',
    id: eventId(3),
    kind: 'DEADLINE',
    note: 'Odečty elektřiny, vody a tepla za říjen pro vyúčtování služeb.',
    related: riverside,
    title: 'Měsíční odečty měřidel – říjen',
  },
  {
    ...audit(),
    assignee: management,
    date: '2026-11-05',
    id: eventId(4),
    kind: 'MEETING',
    note: 'Jednání o prodloužení nájmu a úpravě nájemného od 1. 1. 2027.',
    related: r201,
    title: 'Jednání s nájemcem R201 o prodloužení',
  },
  {
    ...audit(),
    assignee: finance,
    date: '2026-11-10',
    id: eventId(5),
    kind: 'REMINDER',
    title: 'Podklady pro účetní za říjen',
  },
  {
    ...audit(),
    assignee: operations,
    date: '2026-11-18',
    id: eventId(6),
    kind: 'DEADLINE',
    note: 'Vyklizení a malování skladu před předáním novému nájemci.',
    related: s01,
    title: 'Příprava skladu S01 k pronájmu',
  },
  {
    ...audit(),
    date: '2026-12-01',
    id: eventId(7),
    kind: 'REMINDER',
    related: riverside,
    title: 'Instalace vánoční výzdoby areálu',
  },
].map((event) => ({
  ...event,
  ...(event.assignee === undefined ? {} : { assigneeLabel: labels.get(event.assignee.principalId) ?? '' }),
  status: 'PLANNED',
}));

/** Assignment notices the reducer would have produced when management assigned the events above. */
const notifications = events.flatMap((event, index) =>
  event.assignee === undefined || event.assignee.principalId === management.principalId
    ? []
    : [
        {
          category: 'ASSIGNED',
          createdAt,
          createdBy: management,
          dueDate: event.date,
          eventKey: `agenda-event:${event.id}:assigned:${event.assignee.principalId}`,
          href: `/siampark/provoz/agenda?event=${event.id}`,
          id: notificationId(index + 1),
          recipient: event.assignee,
          source: 'ops',
          title: event.title,
        },
      ],
);

export const seedAgendaState = (): AgendaStateEncoded =>
  ({ events, exports: [], notifications, preferences: [] }) as unknown as AgendaStateEncoded;
