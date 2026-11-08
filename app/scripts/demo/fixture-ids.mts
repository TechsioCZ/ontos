/// <reference types="node" />
import { v5 } from 'uuid';
import { salesDemoCustomers } from './data/sales-customers.mts';
import { crmDemoCompany, eshopDemoCompany, rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';

/**
 * Fixed UUIDv5 namespace for every sales-demo fixture identity. Never change it: seeds, tests and the
 * agent rely on the same IDs across cold resets.
 */
export const SALES_DEMO_NAMESPACE = '5a1e5d3e-0000-5000-8000-0000000d3e70' as const;

/** Demo tenant and legal entity shared with the Nájempark baseline (`pnpm demo:reset`). */
export const demoTenantId = '70000000-0000-4000-8000-000000000020' as const;
export const demoLegalEntityId = '71000000-0000-4000-8000-000000000020' as const;
export const rentalDemoLegalEntityId = rentalDemoCompany.legalEntityId;
/** CRM demo company „Velkoobchod Hanák s.r.o.“ and e-shop company „Kavárna Doma s.r.o.“ (same tenant). */
export const crmDemoLegalEntityId = crmDemoCompany.legalEntityId;
export const akrosDemoLegalEntityId = '71000000-0000-4000-8000-000000000024' as const;
export const eshopDemoLegalEntityId = eshopDemoCompany.legalEntityId;

/** RFC 9562 UUIDv5 of `name` inside `namespace`. */
export const uuidV5 = (namespace: string, name: string): string => v5(name, namespace);

/**
 * Deterministic demo ID, e.g. `demoId('workforce.employee', 'obchod')` or
 * `demoId('party.customer', 'ico-27082440')`. Use `<owner>.<resource>` as the namespace and a stable
 * human key; never generate random IDs in seeds.
 */
const rawDemoId = (namespace: string, key: string): string => uuidV5(SALES_DEMO_NAMESPACE, `${namespace}:${key}`);

/** IČO order comes from the operator's sole customer dataset. */
const seededCustomerIcos: readonly string[] = salesDemoCustomers.map(({ ico }) => ico);

const customerIndexKey = /^c(?<index>\d{2})$/u;

/**
 * Seeds reference customers as `demoId('customer', 'c01')`…`'c40'`. party-registry owns the real
 * identities (`party.customer:ico-<IČO>`), so the shorthand resolves to the n-th seeded customer's party ID.
 */
const resolveCustomerShorthand = (key: string): string | undefined => {
  const match = customerIndexKey.exec(key);
  const { index } = match?.groups ?? {};
  const ico = index === undefined ? undefined : seededCustomerIcos[Number(index) - 1];
  return ico === undefined ? undefined : rawDemoId('party.customer', `ico-${ico}`);
};

export const demoId = (namespace: string, key: string): string =>
  (namespace === 'customer' ? resolveCustomerShorthand(key) : undefined) ?? rawDemoId(namespace, key);
