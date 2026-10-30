import { Schema } from 'effect';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../packages/core-runtime/src/auth/staff-authentication-namespace.ts';

/**
 * The runtime configuration the Order flow's owners read besides their database and SpiceDB, shared
 * by the Zerops deployment generator and the Cloudflare stage Worker secret plan so both name the same
 * keys. Owners read every value lazily, so a missing value fails only the work that needs it.
 */

/** How the stage cut-over checks a per-environment value before writing it to a Worker. */
export const OperatorValueFormatSchema = Schema.Literals(['json', 'reference', 'uuid']);
export type OperatorValueFormat = typeof OperatorValueFormatSchema.Type;

/** A per-environment value that is not secret, such as a Principal, Legal Entity or Tenant ID or a grant list. */
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
  /** Namespaces of the API-key callers the unit admits; Shell binds every API key in its staff namespace. */
  readonly callerNamespaces: readonly string[];
  /**
   * Variables holding Shell-issued API keys and other credentials. Operators keep the values in the
   * vault; the repository only names them.
   */
  readonly credentialVariables: readonly string[];
  readonly operatorValues: readonly OperatorValue[];
  readonly unitId: string;
}

export const SHELL_GATEWAY_BASE_URL_VARIABLE = 'ONTOS_SHELL_GATEWAY_BASE_URL';
export const CALLER_NAMESPACE_ID: string = STAFF_AUTHENTICATION_NAMESPACE_ID;

const CART_UNIT = 'commerce-cart';
const CUSTOMER_CONTEXT_UNIT = 'commerce-customer-context';
const ORDER_UNIT = 'commerce-order';

/** An owner API the Cloudflare Worker calls by URL on the owner's custom domain. */
const byUrl = (unitId: string, variable: string): OwnerApiDependency => ({ edge: 'custom-domain', unitId, variable });
/** An owner API only Zerops reaches by URL. */
const zeropsOnly = (unitId: string, variable: string): OwnerApiDependency => ({ edge: 'none', unitId, variable });
const uuid = (variable: string): OperatorValue => ({ format: 'uuid', variable });
const json = (variable: string): OperatorValue => ({ format: 'json', variable });
const reference = (variable: string): OperatorValue => ({ format: 'reference', variable });

const shellGateway = byUrl('shell-super-app', SHELL_GATEWAY_BASE_URL_VARIABLE);
const cartApi = byUrl(CART_UNIT, 'ONTOS_COMMERCE_CART_API_BASE_URL');
const customerContextApi = byUrl(CUSTOMER_CONTEXT_UNIT, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL');

export const OWNER_RUNTIME_CONFIGURATIONS: readonly OwnerRuntimeConfiguration[] = [
  {
    apiDependencies: [byUrl('catalog', 'ONTOS_CATALOG_API_BASE_URL'), customerContextApi, shellGateway],
    callerNamespaces: [],
    credentialVariables: ['ONTOS_CART_FINALIZATION_SERVICE_API_KEY'],
    operatorValues: [json('ONTOS_CART_FINAL_CANDIDATE_SERVICE_GRANTS'), json('ONTOS_CART_PREAPPROVAL_SERVICE_GRANTS')],
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
    callerNamespaces: ['ONTOS_CCC_ORDER_CONSUMER_AUTHENTICATION_NAMESPACE_ID'],
    credentialVariables: [
      'ONTOS_CCC_ORDER_GATEWAY_API_KEY',
      'ONTOS_CCC_PREPROPOSAL_GATEWAY_API_KEY',
      'ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY',
    ],
    operatorValues: [
      uuid('ONTOS_CCC_ORDER_CONSUMER_LEGAL_ENTITY_ID'),
      uuid('ONTOS_CCC_ORDER_CONSUMER_PRINCIPAL_ID'),
      uuid('ONTOS_CCC_ORDER_CONSUMER_TENANT_ID'),
      json('ONTOS_CCC_ORDER_FINALIZATION_SERVICE_GRANTS'),
      uuid('ONTOS_CCC_PREPROPOSAL_PRICING_ISSUER_PRINCIPAL_ID'),
      json('ONTOS_CCC_PREPROPOSAL_SERVICE_GRANTS'),
      json('ONTOS_CCC_PRICING_FINALIZATION_SERVICE_GRANTS'),
    ],
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
    callerNamespaces: [
      'ONTOS_ORDER_CCC_VERIFIER_AUTHENTICATION_NAMESPACE_ID',
      'ONTOS_ORDER_FINALIZATION_WORKER_AUTHENTICATION_NAMESPACE_ID',
      'ONTOS_ORDER_PRICING_VERIFIER_AUTHENTICATION_NAMESPACE_ID',
    ],
    credentialVariables: ['ONTOS_ORDER_APPROVAL_GATEWAY_API_KEY', 'ONTOS_ORDER_FINALIZATION_GATEWAY_API_KEY'],
    operatorValues: [
      uuid('ONTOS_ORDER_CCC_VERIFIER_PRINCIPAL_ID'),
      uuid('ONTOS_ORDER_FINALIZATION_WORKER_PRINCIPAL_ID'),
      uuid('ONTOS_ORDER_PRICING_VERIFIER_PRINCIPAL_ID'),
    ],
    unitId: ORDER_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    callerNamespaces: ['ONTOS_PRICING_ORDER_NAMESPACE_ID', 'ONTOS_PRICING_PREPROPOSAL_NAMESPACE_ID'],
    credentialVariables: ['ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET', 'ONTOS_PRICING_GATEWAY_API_KEY'],
    operatorValues: [
      reference('ONTOS_PRICING_CONFIRMATION_KEY_LINEAGE_REF'),
      reference('ONTOS_PRICING_CONFIRMATION_KEY_REF'),
      reference('ONTOS_PRICING_CONFIRMATION_KEY_VERSION'),
      uuid('ONTOS_PRICING_ORDER_PRINCIPAL_ID'),
      uuid('ONTOS_PRICING_PREPROPOSAL_PRINCIPAL_ID'),
    ],
    unitId: 'pricing',
  },
];

/** An owner API base under its origin: every unit serves its API below `/<unit>-api`. */
export const unitApiBaseUrl = (origin: string, unitId: string) => `${origin}/${unitId}-api`;
