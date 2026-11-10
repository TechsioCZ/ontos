// E-shop order presentation helpers: customer names for guest orders, workflow steps, history wording.
import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { Order } from '../../../../../shared/apis/records.ts';
import type {
  OrderHistoryEntry,
  OrderHistoryKind,
  OrderStatus,
} from '../../../../../shared/domain/merchandise-model.ts';
import { ShippingMethodSchema, shippingMethods } from '../../../../../shared/domain/merchandise-model.ts';
import { Schema } from 'effect';
import type { CustomerDirectory } from './customers-directory.ts';

type Translate = ReturnType<typeof useModernI18n>['t'];

const eshopKey = (path: string) => `merchandise.pages.orders.eshop.${path}`;

/** Guest (storefront) orders carry their own contact; staff orders name a party from the registry. */
export const orderCustomerName = (order: Order, customers: CustomerDirectory): string | null =>
  order.contact?.name ?? customers.nameOf(order.partyId);

export const isStorefrontOrder = (order: Order): boolean => order.channel === 'STOREFRONT';

/** Lines, prices, shipping and address can change until the staff-recorded carrier hand-over. */
export const isOrderEditable = (order: Pick<Order, 'status'>): boolean =>
  order.status === 'NEW' || order.status === 'CONFIRMED' || order.status === 'PACKING';

/** The fixed e-shop workflow, in order. CANCELLED is the side exit. */
export const workflowSteps: readonly { readonly labelKey: string; readonly status: OrderStatus }[] = [
  { labelKey: eshopKey('workflow.new'), status: 'NEW' },
  { labelKey: eshopKey('workflow.confirmed'), status: 'CONFIRMED' },
  { labelKey: eshopKey('workflow.packing'), status: 'PACKING' },
  { labelKey: eshopKey('workflow.shipped'), status: 'SHIPPED' },
  { labelKey: eshopKey('workflow.delivered'), status: 'DELIVERED' },
];

export const workflowIndex = (status: OrderStatus): number => workflowSteps.findIndex((step) => step.status === status);

/** Message keys of the history entry kinds. */
export const historyKindKeys = {
  ADDRESS: eshopKey('history.ADDRESS'),
  CONTACT: eshopKey('history.CONTACT'),
  CREATED: eshopKey('history.CREATED'),
  LINES: eshopKey('history.LINES'),
  NOTE: eshopKey('history.NOTE'),
  SHIPPING: eshopKey('history.SHIPPING'),
  STATUS: eshopKey('history.STATUS'),
} as const satisfies Readonly<Record<OrderHistoryKind, string>>;

/** A demo principal: its role label key and, for the shared demo accounts, the account e-mail. */
interface KnownPrincipal {
  readonly email?: string;
  readonly labelKey: string;
}

const fulfilment: KnownPrincipal = { labelKey: eshopKey('actor.fulfilment') };
const eshopAdministrator: KnownPrincipal = { labelKey: eshopKey('actor.administrator') };

/** Known demo principals, so the history names people instead of opaque ids. */
const knownPrincipals = new Map<string, KnownPrincipal>(
  Object.entries({
    '140ed05d-e8c1-5b56-a0b0-9328a9370586': fulfilment,
    '1aaf0c53-beaf-50b6-819e-fa0c055f5b26': eshopAdministrator,
    '2bdc200d-ad86-5101-b48f-a52339718354': { labelKey: eshopKey('actor.sales') },
    '3952547a-564f-5468-9038-8dce11185c44': { labelKey: eshopKey('actor.warehouse') },
    '3f488baf-7be5-5d9d-994d-186eb91d2f3f': { labelKey: eshopKey('actor.assistant') },
    '493dafec-c9b1-5a84-89cb-bee630de3c34': { labelKey: eshopKey('actor.salesLead') },
    '4f94471b-1d15-5aa9-a836-c87e0f8a449d': { labelKey: eshopKey('actor.accountant') },
    '52f863a1-c09c-5758-af37-74db4ee9c69f': eshopAdministrator,
    '63bb4d05-3edf-59dd-89c8-4a1ffc761154': { email: 'expedice@kavarna.demo', labelKey: eshopKey('actor.fulfilment') },
    '98068f06-a5d7-59eb-860e-0f8fcf5a3888': { labelKey: eshopKey('actor.storefront') },
    'a36f17f1-aafb-529b-b05e-835b255f6a27': fulfilment,
    'c272619c-19a2-5cf8-8860-9614446e02d1': fulfilment,
    'cdfa4353-77ab-5b46-9dc9-b1119ae0d5a9': { email: 'eshop@kavarna.demo', labelKey: eshopKey('actor.administrator') },
    'd347e2d5-1d78-51b5-a0d9-2bb313afe250': eshopAdministrator,
  }),
);

const principalLabel = (principal: KnownPrincipal, t: Translate): string => {
  const label = t(principal.labelKey);
  return principal.email === undefined ? label : t(eshopKey('actor.withEmail'), { email: principal.email, label });
};

export const historyActorLabel = (
  entry: OrderHistoryEntry,
  currentPrincipalId: string | undefined,
  t: Translate,
): string => {
  if (entry.actorLabel !== undefined) {
    return entry.actorLabel;
  }
  if (entry.actor === undefined) {
    return t(eshopKey('actor.system'));
  }
  const known = knownPrincipals.get(entry.actor.principalId);
  if (entry.actor.principalId === currentPrincipalId) {
    return known === undefined
      ? t(eshopKey('actor.you'))
      : t(eshopKey('actor.youAs'), { label: principalLabel(known, t) });
  }
  return known === undefined ? t(eshopKey('actor.unknown')) : principalLabel(known, t);
};

export const shippingOptions = Object.keys(shippingMethods).flatMap((method) => {
  if (!Schema.is(ShippingMethodSchema)(method)) {
    return [];
  }
  return [{ label: shippingMethods[method].label, method, priceMinor: shippingMethods[method].grossPriceMinor }];
});
