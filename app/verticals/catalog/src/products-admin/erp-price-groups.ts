// The company's customer Price Groups the ERP editor lists one Price row each for. Demo shortcut: the AKROS groups the
// ERP price lists created (Price Group Catalog, Symmy route 9e355544…) are named here like the company's ERP offer in
// erp-offer.ts; staff cannot read the catalog's source associations with a company selected yet.
import { Effect } from 'effect';

import type { ErpOffer } from './erp-offer.ts';

export interface ErpPriceGroup {
  readonly label: string;
  readonly priceGroupRef: {
    readonly moduleId: 'pricing.price-group-catalog';
    readonly resourceId: string;
    readonly resourceType: 'pricing.price-group-catalog.price-group';
    readonly tenantId: string;
  };
}

const group = (tenantId: string, resourceId: string, label: string): ErpPriceGroup => ({
  label,
  priceGroupRef: {
    moduleId: 'pricing.price-group-catalog',
    resourceId,
    resourceType: 'pricing.price-group-catalog.price-group',
    tenantId,
  },
});

const akrosTenant = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const groupsByConfiguration: Readonly<Record<string, readonly ErpPriceGroup[]>> = {
  akros: [
    group(akrosTenant, '64cc6324-0de4-418d-bbec-7fe26077db8c', 'Velkoobchod'),
    group(akrosTenant, 'a7bbc612-21a4-44da-9835-7645ccf49927', 'Cenová třída 0'),
    group(akrosTenant, '28103be6-1089-48a8-99a4-c2764c51458a', 'Cenová třída 2'),
    group(akrosTenant, 'e1834b20-a336-4b3e-91e4-7c619179ff21', 'Cenová třída 3'),
  ],
};

/** The company's Price Groups, or none when the offer's company has no ERP price lists. */
export const readErpPriceGroups = (offer: ErpOffer, _requestCorrelation: string) =>
  Effect.succeed<readonly ErpPriceGroup[]>(groupsByConfiguration[offer.customerConfigurationId] ?? []);
