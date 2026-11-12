import { Array as EffectArray, Option, Order, Schema } from 'effect';

/**
 * The runtime configuration delegated module callers read besides their database and SpiceDB, shared
 * by the Zerops deployment generator and the Cloudflare Worker secret plan so both name the same
 * keys. Owners read every value lazily, so a missing value fails only the work that needs it.
 *
 * A module calling another module presents one module credential, `ONTOS_GATEWAY_MODULE_API_KEY`, and
 * the Shell binds that credential to exactly one module through `ONTOS_GATEWAY_MODULE_BINDINGS`.
 */

/** How the stage cut-over checks a per-environment value before writing it to a Worker. */
export const OperatorValueFormatSchema = Schema.Literals(['module-bindings', 'reference']);
export type OperatorValueFormat = typeof OperatorValueFormatSchema.Type;

/** A per-environment value that is not secret, such as a key reference or the Shell's module bindings. */
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

const SERVICE_AND_WORKER = 'service-and-worker';
const WORKER_ONLY = 'worker-only';

export interface OwnerRuntimeConfiguration {
  readonly apiDependencies: readonly OwnerApiDependency[];
  /**
   * Variables holding other secrets the unit reads. Operators keep the values in the vault; the
   * repository only names them.
   */
  readonly credentialVariables: readonly string[];
  /**
   * Which of the unit's deployments hold the module credential. `service-and-worker`: the request service
   * and the Outbox Worker both hold it. `worker-only`: only the Outbox Worker makes delegated module calls,
   * so the request service never receives the credential.
   */
  readonly moduleCredentialHolders: typeof SERVICE_AND_WORKER | typeof WORKER_ONLY;
  /**
   * The operator-held module credential of this unit. Its runtime reads the value as
   * `ONTOS_GATEWAY_MODULE_API_KEY`; the Shell binds the key to this unit only.
   */
  readonly moduleCredentialVariable: string;
  readonly operatorValues: readonly OperatorValue[];
  readonly unitId: string;
}

export const SHELL_GATEWAY_BASE_URL_VARIABLE = 'ONTOS_SHELL_GATEWAY_BASE_URL';
/** The module credential every module deployment reads, whichever operator value supplies it. */
export const GATEWAY_MODULE_API_KEY_VARIABLE = 'ONTOS_GATEWAY_MODULE_API_KEY';
/** The Shell's JSON array binding each module credential to one module deployment. Not secret. */
export const GATEWAY_MODULE_BINDINGS_VARIABLE = 'ONTOS_GATEWAY_MODULE_BINDINGS';

/** The operator-held variable of one unit's module credential, e.g. `ONTOS_GATEWAY_MODULE_API_KEY_COMMERCE_ORDER`. */
export const moduleCredentialVariable = (unitId: string): string =>
  `${GATEWAY_MODULE_API_KEY_VARIABLE}_${unitId.replaceAll('-', '_').toUpperCase()}`;

const ASSORTMENT_UNIT = 'assortment';
const CART_UNIT = 'commerce-cart';
const CUSTOMER_CONTEXT_UNIT = 'commerce-customer-context';
const ORDER_UNIT = 'commerce-order';
const PRICING_UNIT = 'pricing';
const MARKET_CATALOG_UNIT = 'commerce-market-catalog';
const CATALOG_UNIT = 'catalog';
const PAYMENT_UNIT = 'payment';
const PARTY_REGISTRY_UNIT = 'party-registry';
const PRIVACY_UNIT = 'privacy';
const SYMMY_INTEGRATION_UNIT = 'symmy-integration';

/** An owner API the Cloudflare Worker calls by URL on the owner's custom domain. */
const byUrl = (unitId: string, variable: string): OwnerApiDependency => ({ edge: 'custom-domain', unitId, variable });
/** An owner API only Zerops reaches by URL. */
const zeropsOnly = (unitId: string, variable: string): OwnerApiDependency => ({ edge: 'none', unitId, variable });
const moduleBindings = (variable: string): OperatorValue => ({ format: 'module-bindings', variable });
const reference = (variable: string): OperatorValue => ({ format: 'reference', variable });

const shellGateway = byUrl('shell-super-app', SHELL_GATEWAY_BASE_URL_VARIABLE);
const cartApi = byUrl(CART_UNIT, 'ONTOS_COMMERCE_CART_API_BASE_URL');
const customerContextApi = byUrl(CUSTOMER_CONTEXT_UNIT, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL');

/** The Shell's operator values: the module bindings every module credential is checked against. */
export const SHELL_OPERATOR_VALUES: readonly OperatorValue[] = [moduleBindings(GATEWAY_MODULE_BINDINGS_VARIABLE)];

/**
 * Every module deployment that calls another module through `acquireDelegatedGatewayContext`, each with
 * its own module credential. A module that starts calling another module must add its entry here; the
 * deployment contract test derives the callers from source and fails when an entry is missing.
 */
export const OWNER_RUNTIME_CONFIGURATIONS: readonly OwnerRuntimeConfiguration[] = [
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(ASSORTMENT_UNIT),
    operatorValues: [],
    unitId: ASSORTMENT_UNIT,
  },
  {
    apiDependencies: [byUrl(CATALOG_UNIT, 'ONTOS_CATALOG_API_BASE_URL'), customerContextApi, shellGateway],
    credentialVariables: [],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(CART_UNIT),
    operatorValues: [],
    unitId: CART_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(CATALOG_UNIT),
    operatorValues: [],
    unitId: CATALOG_UNIT,
  },
  {
    apiDependencies: [
      // Party Registry's Outbox Worker calls its own API and Privacy's; both are reached inside Zerops only.
      zeropsOnly(PARTY_REGISTRY_UNIT, 'ONTOS_PARTY_REGISTRY_API_BASE_URL'),
      zeropsOnly('privacy', 'ONTOS_PRIVACY_API_BASE_URL'),
      shellGateway,
    ],
    credentialVariables: [],
    moduleCredentialHolders: WORKER_ONLY,
    moduleCredentialVariable: moduleCredentialVariable(PARTY_REGISTRY_UNIT),
    operatorValues: [],
    unitId: PARTY_REGISTRY_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(MARKET_CATALOG_UNIT),
    operatorValues: [],
    unitId: MARKET_CATALOG_UNIT,
  },
  {
    apiDependencies: [
      cartApi,
      byUrl(ORDER_UNIT, 'ONTOS_COMMERCE_ORDER_API_BASE_URL'),
      // The Worker reaches Price Group Catalog through its VERTICAL_PRICE_GROUP_CATALOG_WORKER binding.
      zeropsOnly('price-group-catalog', 'ONTOS_PRICE_GROUP_CATALOG_BASE_URL'),
      shellGateway,
    ],
    credentialVariables: [],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(CUSTOMER_CONTEXT_UNIT),
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
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(ORDER_UNIT),
    operatorValues: [],
    unitId: ORDER_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: ['ONTOS_PAYMENT_PROVIDER_CREDENTIALS'],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(PAYMENT_UNIT),
    operatorValues: [],
    unitId: PAYMENT_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: ['ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET'],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(PRICING_UNIT),
    operatorValues: [
      reference('ONTOS_PRICING_CONFIRMATION_KEY_LINEAGE_REF'),
      reference('ONTOS_PRICING_CONFIRMATION_KEY_REF'),
      reference('ONTOS_PRICING_CONFIRMATION_KEY_VERSION'),
    ],
    unitId: PRICING_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(PRIVACY_UNIT),
    operatorValues: [],
    unitId: PRIVACY_UNIT,
  },
  {
    apiDependencies: [shellGateway],
    credentialVariables: [],
    moduleCredentialHolders: SERVICE_AND_WORKER,
    moduleCredentialVariable: moduleCredentialVariable(SYMMY_INTEGRATION_UNIT),
    operatorValues: [],
    unitId: SYMMY_INTEGRATION_UNIT,
  },
];

export const ownerRuntimeConfiguration = (unitId: string) =>
  OWNER_RUNTIME_CONFIGURATIONS.find((configuration) => configuration.unitId === unitId);

/** Whether the unit's request service receives its module credential; a `worker-only` unit's Outbox Worker alone does. */
export const requestServiceHoldsModuleCredential = (configuration: OwnerRuntimeConfiguration): boolean =>
  configuration.moduleCredentialHolders === SERVICE_AND_WORKER;

/** An owner API base under its origin: every unit serves its API below `/<unit>-api`. */
export const unitApiBaseUrl = (origin: string, unitId: string) => `${origin}/${unitId}-api`;

/**
 * One entry of `ONTOS_GATEWAY_MODULE_BINDINGS`: the Shell's key, the module it binds, and the release it runs.
 * `sourceAppId` takes the Shell's audience rule (a stable topology app ID, as in gateway-delegation-policy.ts).
 */
const GatewayModuleBindingSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  providerKeyId: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ProviderKeyId')),
  sourceAppId: Schema.String.check(
    Schema.makeFilter((value) =>
      /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) ? undefined : 'sourceAppId must be a stable topology app ID',
    ),
  ).pipe(Schema.brand('SourceAppId')),
  sourceBuildMarker: Schema.String.check(Schema.isMinLength(1)),
});
const GatewayModuleBindingsSchema = Schema.fromJsonString(Schema.Array(GatewayModuleBindingSchema));

/** The module that owns each module credential, which the Shell must bind one-to-one. */
export const GATEWAY_MODULE_UNITS: readonly string[] = OWNER_RUNTIME_CONFIGURATIONS.map(({ unitId }) => unitId);

/**
 * Why `ONTOS_GATEWAY_MODULE_BINDINGS` must not be deployed, or `undefined` when it names exactly one
 * binding per module credential, all for one composition revision. It cannot see the published release:
 * the revision and build markers must still equal the release's at publish time (see DEPLOYMENT.md).
 */
export const gatewayModuleBindingsProblem = (value: string): string | undefined => {
  const decoded = Schema.decodeUnknownOption(GatewayModuleBindingsSchema)(value);
  if (Option.isNone(decoded)) {
    return 'a JSON array of module bindings is required';
  }
  const bindings = decoded.value;
  const sourceAppIds = EffectArray.sort(
    bindings.map(({ sourceAppId }) => sourceAppId),
    Order.String,
  );
  if (sourceAppIds.join('\n') !== EffectArray.sort(GATEWAY_MODULE_UNITS, Order.String).join('\n')) {
    return `exactly one binding per module credential is required (${GATEWAY_MODULE_UNITS.join(', ')})`;
  }
  if (new Set(bindings.map(({ providerKeyId }) => providerKeyId)).size !== bindings.length) {
    return 'each module credential must have its own provider key ID';
  }
  if (new Set(bindings.map(({ compositionRevision }) => compositionRevision)).size !== 1) {
    return 'every binding must name the same composition revision';
  }
  return undefined;
};
