// The stable Zerops project's deployment identity: a separate Zerops project that runs the same demo code as stage
// (app/zerops.yaml) with its own services, public origins, mail sender and storefront identities. This file only
// reads and checks that identity; materialize.mjs writes it into the setups. Every value here is a non-secret,
// per-environment string: credentials stay Zerops service variables of the stable project, never in this file.
// Error messages name the offending field, never its value.
import { readFile } from 'node:fs/promises';

export class StableConfigError extends Error {
  name = 'StableConfigError';
}

/** The stable project's services (app/zerops-import.yaml hostnames); `migrator` holds the database credentials. */
export const STABLE_SERVICES = ['app', 'storefront', 'shop', 'n1', 'spicedb', 'db18', 'migrator'];
/** Public origins: the Shell, the AKROS storefront, the pseudonymous shop and the N1 e-shop. */
export const STABLE_ORIGINS = ['shell', 'storefront', 'shop', 'n1'];

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const ZEROPS_ID = /^[\w-]{16,64}$/u;
const SLUG = /^[a-z][\da-z-]*$/u;
const HOSTNAME = /^(?=.{1,253}$)(?:[\da-z](?:[\da-z-]{0,61}[\da-z])?\.)+[a-z][\da-z-]{0,62}$/u;
const SENDER = /^(?:[^<>\r\n]+ )?<?([^\s<>@]+@([^\s<>@]+))>?$/u;

const fail = (path, problem) => {
  throw new StableConfigError(`stable config ${path} ${problem}`);
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, path, keys) => {
  if (!isObject(value)) fail(path, 'must be an object');
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(path, `has unknown keys ${unknown.join(', ')}; allowed: ${keys.join(', ') || 'none'}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) fail(path, `is missing ${missing.join(', ')}`);
  return value;
};
const text = (value, path, pattern, what) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) fail(path, 'must be a trimmed non-empty string');
  if (pattern !== undefined && !pattern.test(value)) fail(path, `must be ${what}`);
  return value;
};
const json = (value, path) => {
  text(value, path);
  try {
    return JSON.parse(value);
  } catch {
    return fail(path, 'must be JSON');
  }
};
const distinct = (values, path) => {
  const seen = new Set();
  for (const [key, value] of values) {
    if (seen.has(value)) fail(`${path}.${key}`, 'must differ from every other entry');
    seen.add(value);
  }
};

const origin = (value, path) => {
  text(value, path);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(path, 'must be an https origin');
  }
  if (url.protocol !== 'https:' || url.origin !== value || url.port !== '' || !HOSTNAME.test(url.hostname)) {
    fail(path, 'must be a bare https origin such as https://host.example, without port, path or trailing slash');
  }
  return value;
};

const sender = (value, path) => {
  const match = SENDER.exec(text(value, path));
  if (match === null || !HOSTNAME.test(match[2] ?? '')) fail(path, 'must be a sender such as Name <noreply@host.example>');
  return value;
};

/** One storefront's ERP offer, keyed by its own Legal Entity only (akros-storefront/src/ontos/erp-config.ts). */
const erpOffers = (value, path, legalEntityId) => {
  const offers = json(value, path);
  if (!isObject(offers) || Object.keys(offers).length !== 1 || !(legalEntityId in offers)) {
    fail(path, 'must be a JSON object with exactly one entry, keyed by this service ONTOS_STOREFRONT_LEGAL_ENTITY_ID');
  }
  const offer = offers[legalEntityId];
  const at = `${path}.${legalEntityId}`;
  if (!isObject(offer)) fail(at, 'must be an object');
  text(offer.customerConfigurationId, `${at}.customerConfigurationId`);
  text(offer.channelId, `${at}.channelId`, /^B2[BC]$/u, 'B2C or B2B');
  text(offer.marketId, `${at}.marketId`);
  text(offer.currencyCode, `${at}.currencyCode`, /^[A-Z]{3}$/u, 'an ISO currency code');
  text(offer.unitId, `${at}.unitId`, UUID, 'a UUID');
  text(offer.unitQuantity, `${at}.unitQuantity`, /^(?:0|[1-9]\d*)(?:\.\d+)?$/u, 'a canonical decimal');
  return JSON.stringify(offers);
};

const hostList = (value, path) => {
  if (typeof value !== 'string') fail(path, 'must be a comma-separated hostname list');
  const hosts = value.split(',');
  if (hosts.some((host) => !HOSTNAME.test(host))) fail(path, 'must be comma-separated hostnames without spaces');
  return value;
};

const storefrontVariables = {
  required: {
    STOREFRONT_BRAND: (value, path) => text(value, path, SLUG, 'a brand id'),
    ONTOS_STOREFRONT_APP_ID: (value, path) => text(value, path, SLUG, 'an application id'),
    ONTOS_STOREFRONT_LEGAL_ENTITY_ID: (value, path) => text(value, path, UUID, 'a UUID').toLowerCase(),
  },
  optional: {
    ONTOS_STOREFRONT_ERP_OFFERS: (value, path, variables) =>
      erpOffers(value, path, variables.ONTOS_STOREFRONT_LEGAL_ENTITY_ID.toLowerCase()),
  },
};

/**
 * The variables each stable setup takes from the config, by setup. These are exactly the canonical demo values that
 * materialization removes: a key absent from the config is absent from the stable setup, never inherited from stage.
 */
export const STABLE_VARIABLES = {
  app: {
    required: {
      SMTP_FROM: sender,
      CLOUDFLARE_EMAIL_ACCOUNT_ID: (value, path) => text(value, path, /^[\da-f]{32}$/u, 'a Cloudflare account id'),
    },
    optional: {
      ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: (value, path) => text(value, path, /^(?:true|false)$/u, 'true or false'),
    },
  },
  storefront: storefrontVariables,
  shop: storefrontVariables,
  n1: {
    required: {
      ONTOS_STOREFRONT_LEGAL_ENTITY_ID: (value, path) => text(value, path, UUID, 'a UUID').toLowerCase(),
      ONTOS_STOREFRONT_TENANT_ID: (value, path) => text(value, path, UUID, 'a UUID').toLowerCase(),
      STOREFRONT_IMAGE_HOSTS: hostList,
    },
    optional: {},
  },
  spicedb: { required: {}, optional: {} },
};

const setupVariables = (value, path, rules) => {
  if (!isObject(value)) fail(path, 'must be an object');
  const allowed = [...Object.keys(rules.required), ...Object.keys(rules.optional)];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(path, `has unknown keys ${unknown.join(', ')}; allowed: ${allowed.join(', ') || 'none'}`);
  const normalized = {};
  for (const [key, check] of Object.entries(rules.required)) {
    if (!(key in value)) fail(path, `is missing ${key}`);
    normalized[key] = check(value[key], `${path}.${key}`, normalized);
  }
  for (const [key, check] of Object.entries(rules.optional)) {
    if (key in value) normalized[key] = check(value[key], `${path}.${key}`, normalized);
  }
  return normalized;
};

const deepFreeze = (value) => {
  if (isObject(value)) for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

/**
 * Checks a parsed stable config and returns it normalized (JSON variables compact, UUIDs lower-case) and frozen.
 * Throws StableConfigError naming the first offending field.
 */
export const validateStableConfig = (value) => {
  const config = exactKeys(value, '(root)', ['schemaVersion', 'projectId', 'demoProjectId', 'services', 'origins', 'variables']);
  if (config.schemaVersion !== 1) fail('schemaVersion', 'must be 1');
  const projectId = text(config.projectId, 'projectId', ZEROPS_ID, 'a Zerops project id');
  const demoProjectId = text(config.demoProjectId, 'demoProjectId', ZEROPS_ID, 'a Zerops project id');
  if (projectId === demoProjectId) fail('projectId', 'must be a new project, not the demo project');

  const services = {};
  for (const [key, id] of Object.entries(exactKeys(config.services, 'services', STABLE_SERVICES))) {
    services[key] = text(id, `services.${key}`, ZEROPS_ID, 'a Zerops service id');
    if (id === projectId || id === demoProjectId) fail(`services.${key}`, 'must be a service id, not a project id');
  }
  distinct(Object.entries(services), 'services');

  const origins = {};
  for (const [key, value] of Object.entries(exactKeys(config.origins, 'origins', STABLE_ORIGINS))) {
    origins[key] = origin(value, `origins.${key}`);
  }
  distinct(Object.entries(origins).map(([key, value]) => [key, new URL(value).hostname]), 'origins');

  const variables = {};
  for (const [setup, entries] of Object.entries(exactKeys(config.variables, 'variables', Object.keys(STABLE_VARIABLES)))) {
    variables[setup] = setupVariables(entries, `variables.${setup}`, STABLE_VARIABLES[setup]);
  }
  for (const key of ['STOREFRONT_BRAND', 'ONTOS_STOREFRONT_APP_ID', 'ONTOS_STOREFRONT_LEGAL_ENTITY_ID']) {
    if (variables.storefront[key] === variables.shop[key]) fail(`variables.shop.${key}`, 'must differ from the storefront');
  }

  return deepFreeze({ schemaVersion: 1, projectId, demoProjectId, services, origins, variables });
};

/** Reads and checks a stable config file (JSON). */
export const loadStableConfig = async (path) => {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new StableConfigError(`stable config ${path} is not readable JSON (${error.code ?? error.name})`);
  }
  return validateStableConfig(value);
};
