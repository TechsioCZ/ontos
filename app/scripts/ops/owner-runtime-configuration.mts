import { Schema } from 'effect';

/**
 * The runtime configuration the Order flow's owners read besides their database and SpiceDB, which the app host
 * derives each owner's API bases from. Owners read every value lazily, so a missing value fails only the work that
 * needs it. Module-to-module calls carry no configured Principal: the Shell signs the calling module as the actor of
 * a delegated call, and each owner admits that actor (see DEPLOYMENT.md, Order-flow owner credentials).
 */

/** How an operator checks a per-environment value before recording it. */
export const OperatorValueFormatSchema = Schema.Literals(['reference']);
export type OperatorValueFormat = typeof OperatorValueFormatSchema.Type;

/** A per-environment value that is not secret, such as a key reference. */
export interface OperatorValue {
  readonly format: OperatorValueFormat;
  readonly variable: string;
}

/** One owner API a unit calls by URL: the variable naming its base and the topology unit serving it. */
export interface OwnerApiDependency {
  /**
   * `custom-domain` when the Cloudflare Worker calls it by URL; `none` when the Worker reaches it
   * through a service binding or never calls it (only the owner's Outbox Worker on Zerops does).
   */
  readonly edge: 'custom-domain' | 'none';
  readonly unitId: string;
  readonly variable: string;
}

export interface OwnerRuntimeConfiguration {
  readonly apiDependencies: readonly OwnerApiDependency[];
  /** Variables holding credentials. Operators keep the values in the vault; the repository only names them. */
  readonly credentialVariables: readonly string[];
  readonly operatorValues: readonly OperatorValue[];
  readonly unitId: string;
}

export const SHELL_GATEWAY_BASE_URL_VARIABLE = 'ONTOS_SHELL_GATEWAY_BASE_URL';

const ASSORTMENT_UNIT = 'assortment';
const CART_UNIT = 'commerce-cart';
const CUSTOMER_CONTEXT_UNIT = 'commerce-customer-context';
const ORDER_UNIT = 'commerce-order';
const PRIVACY_UNIT = 'privacy';
const SYMMY_INTEGRATION_UNIT = 'symmy-integration';

/** An owner API the Cloudflare Worker calls by URL on the owner's custom domain. */
const byUrl = (unitId: string, variable: string): OwnerApiDependency => ({ edge: 'custom-domain', unitId, variable });
/** An owner API only Zerops reaches by URL. */
const zeropsOnly = (unitId: string, variable: string): OwnerApiDependency => ({ edge: 'none', unitId, variable });
const reference = (variable: string): OperatorValue => ({ format: 'reference', variable });

const shellGateway = byUrl('shell-super-app', SHELL_GATEWAY_BASE_URL_VARIABLE);
const cartApi = byUrl(CART_UNIT, 'ONTOS_COMMERCE_CART_API_BASE_URL');
const customerContextApi = byUrl(CUSTOMER_CONTEXT_UNIT, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL');

export const OWNER_RUNTIME_CONFIGURATIONS: readonly OwnerRuntimeConfiguration[] = [
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    operatorValues: [],
    unitId: ASSORTMENT_UNIT,
  },
  {
    apiDependencies: [byUrl('catalog', 'ONTOS_CATALOG_API_BASE_URL'), customerContextApi, shellGateway],
    credentialVariables: [],
    operatorValues: [],
    unitId: CART_UNIT,
  },
  {
    apiDependencies: [
      cartApi,
      byUrl(ORDER_UNIT, 'ONTOS_COMMERCE_ORDER_API_BASE_URL'),
      // The Worker reaches Price Group Catalog through its VERTICAL_PRICE_GROUP_CATALOG_WORKER binding.
      zeropsOnly('price-group-catalog', 'ONTOS_PRICE_GROUP_CATALOG_BASE_URL'),
      shellGateway,
    ],
    credentialVariables: [
      // Per-Tenant Core identity and gateway keys: { "<tenant id>": { coreIdentityApiKey, gatewayApiKey } }.
      'COMMERCE_TENANT_CREDENTIALS',
    ],
    operatorValues: [],
    unitId: CUSTOMER_CONTEXT_UNIT,
  },
  {
    apiDependencies: [
      cartApi,
      customerContextApi,
      // Only the Order Outbox Worker, which runs on Zerops, calls the Order API.
      zeropsOnly(ORDER_UNIT, 'ONTOS_ORDER_API_BASE_URL'),
      byUrl('payment-term-catalog', 'ONTOS_PAYMENT_TERM_CATALOG_API_BASE_URL'),
      byUrl('pricing', 'ONTOS_PRICING_API_BASE_URL'),
      shellGateway,
      byUrl('tax', 'ONTOS_TAX_API_BASE_URL'),
    ],
    credentialVariables: [],
    operatorValues: [],
    unitId: ORDER_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: ['ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET'],
    operatorValues: [
      reference('ONTOS_PRICING_CONFIRMATION_KEY_LINEAGE_REF'),
      reference('ONTOS_PRICING_CONFIRMATION_KEY_REF'),
      reference('ONTOS_PRICING_CONFIRMATION_KEY_VERSION'),
    ],
    unitId: 'pricing',
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    operatorValues: [],
    unitId: PRIVACY_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    operatorValues: [],
    unitId: SYMMY_INTEGRATION_UNIT,
  },
];

/** An owner API base under its origin: every unit serves its API below `/<unit>-api`. */
export const unitApiBaseUrl = (origin: string, unitId: string) => `${origin}/${unitId}-api`;
