// E-shop order presentation helpers: customer names for guest orders, workflow steps, history wording.
import type { Order } from '../../../../../shared/apis/records.ts';
import type {
  OrderHistoryEntry,
  OrderHistoryKind,
  OrderStatus,
  ShippingMethod,
} from '../../../../../shared/domain/merchandise-model.ts';
import { shippingMethods } from '../../../../../shared/domain/merchandise-model.ts';
import type { CustomerDirectory } from './customers-directory.ts';

/** Guest (storefront) orders carry their own contact; staff orders name a party from the registry. */
export const orderCustomerName = (order: Order, customers: CustomerDirectory): string | null =>
  order.contact?.name ?? customers.nameOf(order.partyId);

export const isStorefrontOrder = (order: Order): boolean => order.channel === 'STOREFRONT';

/** Lines, prices, shipping and address can change until the simulated carrier hand-over. */
export const isOrderEditable = (order: Pick<Order, 'status'>): boolean =>
  order.status === 'NEW' || order.status === 'CONFIRMED' || order.status === 'PACKING';

/** The fixed e-shop workflow, in order. CANCELLED is the side exit. */
export const workflowSteps: readonly { readonly label: string; readonly status: OrderStatus }[] = [
  { label: 'Nová', status: 'NEW' },
  { label: 'Zpracovává se', status: 'CONFIRMED' },
  { label: 'Připravená k předání', status: 'PACKING' },
  { label: 'Předáno dopravci (simulace)', status: 'SHIPPED' },
  { label: 'Dokončená', status: 'DELIVERED' },
];

export const workflowIndex = (status: OrderStatus): number => workflowSteps.findIndex((step) => step.status === status);

export const historyKindLabels: Readonly<Record<OrderHistoryKind, string>> = {
  ADDRESS: 'Doručovací adresa',
  CONTACT: 'Kontakt',
  CREATED: 'Objednávka vytvořena',
  LINES: 'Položky a ceny',
  NOTE: 'Poznámka',
  SHIPPING: 'Doprava',
  STATUS: 'Změna stavu',
};

/** Known demo principals, so the history names people instead of opaque ids. */
const knownPrincipals: Readonly<Record<string, string>> = {
  '2bdc200d-ad86-5101-b48f-a52339718354': 'Obchodník',
  '3952547a-564f-5468-9038-8dce11185c44': 'Skladník',
  '3f488baf-7be5-5d9d-994d-186eb91d2f3f': 'AI asistent',
  '493dafec-c9b1-5a84-89cb-bee630de3c34': 'Vedoucí obchodu',
  '4f94471b-1d15-5aa9-a836-c87e0f8a449d': 'Účetní',
  '63bb4d05-3edf-59dd-89c8-4a1ffc761154': 'Expedice (expedice@kavarna.demo)',
  '98068f06-a5d7-59eb-860e-0f8fcf5a3888': 'E-shop (storefront)',
  'cdfa4353-77ab-5b46-9dc9-b1119ae0d5a9': 'Správce e-shopu (eshop@kavarna.demo)',
};

export const historyActorLabel = (entry: OrderHistoryEntry, currentPrincipalId: string | undefined): string => {
  if (entry.actorLabel !== undefined) {
    return entry.actorLabel;
  }
  if (entry.actor === undefined) {
    return 'Systém';
  }
  const known = knownPrincipals[entry.actor.principalId];
  if (entry.actor.principalId === currentPrincipalId) {
    return known === undefined ? 'Vy' : `${known} (vy)`;
  }
  return known ?? `Pracovník …${entry.actor.principalId.slice(-6)}`;
};

export const shippingOptions = (Object.keys(shippingMethods) as ShippingMethod[]).map((method) => ({
  label: shippingMethods[method].label,
  method,
  priceMinor: shippingMethods[method].grossPriceMinor,
}));

/** Text the orders table search runs against: number, customer, e-mail. */
export const orderSearchText = (order: Order, customers: CustomerDirectory): string =>
  [order.number, orderCustomerName(order, customers) ?? '', order.contact?.email ?? ''].join(' ');
