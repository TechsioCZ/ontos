// The private verification manifest (STABLE_VERIFICATION_FILE): the dedicated verification accounts, the ERP key, the
// control inbox and the explicit mutation plan of one stable verification run. It never lives in the repository;
// verify-manifest.example.json shows its shape with placeholders. Every key is required and no other key is allowed:
// a journey without its configuration fails, it is never skipped. Error messages name the field, never its value.
import { readFile } from 'node:fs/promises';

export class VerificationManifestError extends Error {
  name = 'VerificationManifestError';
}

export const MANIFEST_KIND = 'ontos.stable.verification-manifest';
/** The writes a verification run makes. Each must be listed in `mutations`, bound to its exact target. */
export const MUTATION_IDS = Object.freeze(['erp-synthetic-import', 'control-email', 'mcp-task-proposal']);

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
const ZEROPS_ID = /^[\w-]{16,64}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const fail = (path, problem) => {
  throw new VerificationManifestError(`verification manifest ${path} ${problem}`);
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, path, keys) => {
  if (!isObject(value)) fail(path, 'must be an object');
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(path, `has unknown keys ${unknown.join(', ')}; allowed: ${keys.join(', ')}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) fail(path, `is missing ${missing.join(', ')}`);
  return value;
};
const text = (value, path, pattern, what) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) fail(path, 'must be a trimmed non-empty string');
  if (pattern !== undefined && !pattern.test(value)) fail(path, `must be ${what}`);
  return value;
};
const uuid = (value, path) => text(value, path, UUID, 'a lower-case UUID');
const email = (value, path) => text(value, path, EMAIL, 'an e-mail address').toLowerCase();
const nonEmptyList = (value, path, item) => {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array');
  return value.map((entry, index) => item(entry, `${path}[${String(index)}]`));
};
const httpsOrigin = (value, path) => {
  text(value, path);
  const url = URL.parse(value);
  if (url === null || url.protocol !== 'https:' || url.origin !== value) fail(path, 'must be a bare https origin');
  return value;
};
const account = (value, path, extra = {}) => {
  const entry = exactKeys(value, path, ['email', 'password', ...Object.keys(extra)]);
  const result = { email: email(entry.email, `${path}.email`), password: text(entry.password, `${path}.password`) };
  for (const [key, check] of Object.entries(extra)) result[key] = check(entry[key], `${path}.${key}`);
  return result;
};

/** SymmyProofInput of app/scripts/ops/stage-symmy-full-function-proof.mts; the proof checks every field again. */
const symmyInput = (value, path) => {
  const input = exactKeys(value, path, ['commercialScope', 'currencyCode', 'locationKey', 'unitRef']);
  const scope = exactKeys(input.commercialScope, `${path}.commercialScope`, ['channelId', 'marketId']);
  text(scope.channelId, `${path}.commercialScope.channelId`, /^B2[BC]$/u, 'B2C or B2B');
  text(scope.marketId, `${path}.commercialScope.marketId`);
  text(input.currencyCode, `${path}.currencyCode`, /^[A-Z]{3}$/u, 'an ISO currency code');
  text(input.locationKey, `${path}.locationKey`);
  const unit = exactKeys(input.unitRef, `${path}.unitRef`, ['moduleId', 'resourceId', 'resourceType', 'tenantId']);
  text(unit.moduleId, `${path}.unitRef.moduleId`);
  uuid(unit.resourceId, `${path}.unitRef.resourceId`);
  text(unit.resourceType, `${path}.unitRef.resourceType`);
  uuid(unit.tenantId, `${path}.unitRef.tenantId`);
  return input;
};
/** SymmyProofStockSource of the same proof. */
const symmyStockSource = (value, path) => {
  const source = exactKeys(value, path, ['customerConfigurationId', 'externalScope', 'issuer', 'namespace']);
  text(source.customerConfigurationId, `${path}.customerConfigurationId`);
  text(source.externalScope, `${path}.externalScope`);
  text(source.namespace, `${path}.namespace`);
  const issuer = exactKeys(source.issuer, `${path}.issuer`, ['backendId', 'backendKind']);
  text(issuer.backendId, `${path}.issuer.backendId`);
  text(issuer.backendKind, `${path}.issuer.backendKind`);
  return source;
};

const senderAddress = (sender) => /<([^<>]+)>\s*$/u.exec(sender)?.[1] ?? sender;

/**
 * Checks a parsed manifest against the stable config it verifies.
 * @param {unknown} value The parsed manifest.
 * @param {object} config A loadStableConfig result.
 * @param {{ isTestRecipient: (address: string) => boolean }} app The app's own rule: the e-mail transport's
 *   test-recipient rule.
 */
export const validateVerificationManifest = (value, config, app) => {
  const root = exactKeys(value, '(root)', [
    'schemaVersion',
    'kind',
    'projectId',
    'accounts',
    'erp',
    'controlInbox',
    'mutations',
  ]);
  if (root.schemaVersion !== 1) fail('schemaVersion', 'must be 1');
  if (root.kind !== MANIFEST_KIND) fail('kind', `must be ${MANIFEST_KIND}`);
  if (text(root.projectId, 'projectId', ZEROPS_ID, 'a Zerops project id') !== config.projectId) {
    fail('projectId', 'must equal the stable config projectId');
  }

  const accounts = exactKeys(root.accounts, 'accounts', ['staffSales', 'tenantSwitcher', 'customer', 'erpOperator', 'mcp']);
  const staffSales = account(accounts.staffSales, 'accounts.staffSales', {
    tenantId: uuid,
    legalEntityId: uuid,
    expectedModuleIds: (entry, path) => nonEmptyList(entry, path, (item, at) => text(item, at)),
  });
  const tenantSwitcher = account(accounts.tenantSwitcher, 'accounts.tenantSwitcher', {
    allowedTenantId: uuid,
    deniedTenantId: uuid,
  });
  if (tenantSwitcher.allowedTenantId === tenantSwitcher.deniedTenantId) {
    fail('accounts.tenantSwitcher.deniedTenantId', 'must differ from allowedTenantId');
  }
  const customer = account(accounts.customer, 'accounts.customer', { tenantId: uuid });
  const erpOperator = account(accounts.erpOperator, 'accounts.erpOperator', { legalEntityId: uuid });
  // The stable verification tenant's persona; the MCP OAuth proof checks whoami against exactly this principal and
  // company (E2E_VERIFICATION_* of app/scripts/demo/mcp-oauth-e2e/env.mts).
  const mcp = account(accounts.mcp, 'accounts.mcp', { principalId: uuid, legalEntityId: uuid });

  const erpEntry = exactKeys(root.erp, 'erp', ['apiKey', 'legalEntityId', 'input', 'stockSource', 'expectedOrderIds']);
  const erp = {
    apiKey: text(erpEntry.apiKey, 'erp.apiKey'),
    expectedOrderIds: nonEmptyList(erpEntry.expectedOrderIds, 'erp.expectedOrderIds', (item, at) => text(item, at)),
    input: symmyInput(erpEntry.input, 'erp.input'),
    legalEntityId: uuid(erpEntry.legalEntityId, 'erp.legalEntityId'),
    stockSource: symmyStockSource(erpEntry.stockSource, 'erp.stockSource'),
  };
  const shopEntities = ['storefront', 'shop', 'n1'].map((setup) => config.variables[setup].ONTOS_STOREFRONT_LEGAL_ENTITY_ID);
  if (shopEntities.includes(erp.legalEntityId)) {
    fail('erp.legalEntityId', 'must be a dedicated verification company, not a storefront company of the stable config');
  }
  if (erpOperator.legalEntityId !== erp.legalEntityId) fail('accounts.erpOperator.legalEntityId', 'must equal erp.legalEntityId');

  const inbox = exactKeys(root.controlInbox, 'controlInbox', ['address', 'api', 'apiOrigin', 'authorization']);
  const controlInbox = {
    address: email(inbox.address, 'controlInbox.address'),
    api: inbox.api === 'mailpit' ? 'mailpit' : fail('controlInbox.api', 'must be mailpit (the Mailpit HTTP API)'),
    apiOrigin: httpsOrigin(inbox.apiOrigin, 'controlInbox.apiOrigin'),
    authorization: text(inbox.authorization, 'controlInbox.authorization', /^(?:Basic|Bearer) \S+$/u, 'Basic … or Bearer …'),
    // Portal mail leaves through SMTP_FROM (commerce-customer-context platform-email-delivery.ts).
    expectedSender: senderAddress(config.variables.app.SMTP_FROM).toLowerCase(),
  };
  if (app.isTestRecipient(controlInbox.address)) {
    fail('controlInbox.address', 'is a test recipient the e-mail transport reroutes to its test capture; use a real allowlisted inbox');
  }
  if (customer.email !== controlInbox.address) fail('accounts.customer.email', 'must equal controlInbox.address');

  const targets = {
    'control-email': ['recipient', controlInbox.address, email],
    'erp-synthetic-import': ['tenantId', erp.input.unitRef.tenantId, uuid],
    'mcp-task-proposal': ['account', mcp.email, email],
  };
  if (!Array.isArray(root.mutations)) fail('mutations', 'must be an array');
  const mutations = {};
  for (const [index, entry] of root.mutations.entries()) {
    const at = `mutations[${String(index)}]`;
    if (!isObject(entry) || !MUTATION_IDS.includes(entry.id)) fail(`${at}.id`, `must be one of ${MUTATION_IDS.join(', ')}`);
    if (entry.id in mutations) fail(`${at}.id`, 'is listed twice');
    const [key, expected, check] = targets[entry.id];
    exactKeys(entry, at, ['id', key]);
    if (check(entry[key], `${at}.${key}`) !== expected) fail(`${at}.${key}`, `must name the exact ${entry.id} target`);
    mutations[entry.id] = expected;
  }
  const absent = MUTATION_IDS.filter((id) => !(id in mutations));
  if (absent.length > 0) fail('mutations', `must opt in to ${absent.join(', ')}`);

  return { accounts: { customer, erpOperator, mcp, staffSales, tenantSwitcher }, controlInbox, erp, mutations };
};

/** Every secret of a manifest, for the redactor. */
export const manifestSecrets = (manifest) => [
  ...Object.values(manifest.accounts).map((entry) => entry.password),
  manifest.erp.apiKey,
  manifest.controlInbox.authorization,
  manifest.controlInbox.authorization.split(' ')[1],
];

export const loadVerificationManifest = async (path, config, app) => {
  if (typeof path !== 'string' || path.length === 0) {
    throw new VerificationManifestError('STABLE_VERIFICATION_FILE is not set; it names the private verification manifest');
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new VerificationManifestError(`verification manifest is not readable JSON (${error.code ?? error.name})`);
  }
  return validateVerificationManifest(value, config, app);
};
