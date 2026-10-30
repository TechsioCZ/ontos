import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { derivedEnvironment, finiteProcessEnvironment, processEnvironment, routeRequest } from '../zerops/app-host.mts';
import { hostedUnits } from '../zerops/hosted-units.mts';
import type { ReleaseIntent, Topology } from '../zerops/hosted-units.mts';
import { ownerEntrySource } from '../zerops/owner-entry.mts';

const PARTY_REGISTRY = 'party-registry';
const SHELL_ID = 'shell-super-app';
const ORIGIN = 'https://ontos.example.com';
const DIST = '/abs/app/dist';
const resolvePackage = (specifier: string) => `/abs/app/node_modules/${specifier}/index.js`;

const topology: Topology = {
  shell: { path: 'app/shell' },
  verticals: [
    {
      id: 'crm',
      moduleFederation: { manifestUrl: new URL('http://localhost:4125/mf-manifest.json') },
      path: 'verticals/crm',
    },
    { id: 'pricing', path: 'verticals/pricing', surfaceProfile: 'api-only' },
    {
      id: PARTY_REGISTRY,
      moduleFederation: { manifestUrl: new URL('http://localhost:4102/mf-manifest.json') },
      path: 'verticals/party-registry',
    },
    { id: 'tax', path: 'verticals/tax', surfaceProfile: 'api-only' },
    {
      id: 'inventory',
      moduleFederation: { manifestUrl: new URL('http://localhost:4110/mf-manifest.json') },
      path: 'verticals/inventory',
    },
  ],
};

const intent: ReleaseIntent = {
  modules: [{ appId: 'crm' }, { appId: 'pricing' }, { appId: PARTY_REGISTRY }, { appId: 'tax' }],
};

describe('hostedUnits', () => {
  it('serves the Shell first on its fixed port', () => {
    const [shell] = hostedUnits(topology, intent);
    expect(shell).toEqual({ browser: true, directory: 'app/shell', id: SHELL_ID, port: 3020 });
  });

  it('gives each browser vertical the port of its Module Federation manifest', () => {
    const ports = hostedUnits(topology, intent).map(({ id, port }) => [id, port]);
    expect(ports).toContainEqual(['crm', 4125]);
    expect(ports).toContainEqual([PARTY_REGISTRY, 4102]);
  });

  it('gives api-only units 4200, 4201 in topology order', () => {
    const units = hostedUnits(topology, intent);
    expect(units.filter(({ browser }) => !browser).map(({ id, port }) => [id, port])).toEqual([
      ['pricing', 4200],
      ['tax', 4201],
    ]);
  });

  it('excludes units that are not in the release intent', () => {
    const ids = hostedUnits(topology, intent).map(({ id }) => id);
    expect(ids).toEqual([SHELL_ID, 'crm', 'pricing', PARTY_REGISTRY, 'tax']);
    expect(ids).not.toContain('inventory');
  });
});

describe('routeRequest', () => {
  const owners = new Map([
    ['crm', 4125],
    [SHELL_ID, 3020],
  ]);

  it('routes non-module paths to the Shell with the same path', () => {
    expect(Option.getOrUndefined(routeRequest('/cs/crm', owners))).toEqual({ path: '/cs/crm', port: 3020 });
  });

  it('routes a module asset to its owner under the owner root path', () => {
    expect(Option.getOrUndefined(routeRequest('/_m/crm/mf-manifest.json', owners))).toEqual({
      path: '/mf-manifest.json',
      port: 4125,
    });
  });

  it('routes the bare module prefix to the owner root', () => {
    expect(Option.getOrUndefined(routeRequest('/_m/crm', owners))).toEqual({ path: '/', port: 4125 });
  });

  it('returns none for an unknown app id', () => {
    expect(Option.isNone(routeRequest('/_m/unknown/x', owners))).toBe(true);
  });

  it('returns none for a module path that names the Shell', () => {
    expect(Option.isNone(routeRequest('/_m/shell-super-app/x', owners))).toBe(true);
  });
});

describe('finiteProcessEnvironment', () => {
  it('keeps one-shot migrators and verifiers on private pools even when the supervisor shares pools', () => {
    const environment = finiteProcessEnvironment({
      MIGRATOR_ONCE: 'true',
      ONTOS_DATABASE_POOL_SHARED: 'true',
    });
    expect(environment.ONTOS_DATABASE_POOL_SHARED).toBe('false');
    expect(environment.MIGRATOR_ONCE).toBe('true');
  });

  it('overrides inherited sharing without changing other operator settings', () => {
    expect(finiteProcessEnvironment({ MIGRATOR_ONCE: 'true' })).toEqual({
      MIGRATOR_ONCE: 'true',
      ONTOS_DATABASE_POOL_SHARED: 'false',
    });
  });
});

describe('processEnvironment', () => {
  const derived = { ONTOS_GATEWAY_ISSUER: ORIGIN };

  it('budgets the shared request pool for all owners, separately from the Shell and workers', () => {
    const owners = processEnvironment(['crm', PARTY_REGISTRY], {}, derived).environment;
    const shell = processEnvironment([SHELL_ID], {}, derived).environment;
    const workers = processEnvironment(['outbox-worker-host', 'crm', PARTY_REGISTRY], {}, derived).environment;

    expect(owners.ONTOS_DATABASE_POOL_MAX_CONNECTIONS).toBe('12');
    expect(shell.ONTOS_DATABASE_POOL_MAX_CONNECTIONS).toBe('6');
    expect(workers.ONTOS_DATABASE_POOL_MAX_CONNECTIONS).toBe('2');
    // Two roles in each child process, plus the supervisor's six and a private lock session.
    // Two releases leave room for SpiceDB, migration/verifier jobs and operator connections.
    const overlappingHosts = 2 * (2 * 12 + 2 * 6 + 2 * 2 + 6 + 1);
    expect(overlappingHosts + 10 + 16 + 2).toBeLessThan(150);
  });

  it('does not let stored owner settings replace the host-owned shared pool budget', () => {
    const secrets = {
      crm: { ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '4', ONTOS_DATABASE_POOL_SHARED: 'false' },
      [PARTY_REGISTRY]: { ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '2' },
    };
    const { conflicts, environment } = processEnvironment(['crm', PARTY_REGISTRY], secrets, derived);

    expect(conflicts).toEqual([]);
    expect(environment.ONTOS_DATABASE_POOL_MAX_CONNECTIONS).toBe('12');
    expect(environment.ONTOS_DATABASE_POOL_SHARED).toBeUndefined();
  });

  it('always removes the migration admin URL and the owner secrets bundle', () => {
    const { environment } = processEnvironment(['crm'], {}, derived);
    expect(Object.keys(environment)).toContain('DATABASE_ADMIN_URL');
    expect(Object.keys(environment)).toContain('ONTOS_OWNER_SECRETS_JSON');
    expect(environment.DATABASE_ADMIN_URL).toBeUndefined();
    expect(environment.ONTOS_OWNER_SECRETS_JSON).toBeUndefined();
  });

  it('removes party-registry database identity from a process that does not serve it', () => {
    const secrets = { [PARTY_REGISTRY]: { PARTY_REGISTRY_DATABASE_URL: 'postgres://registry' } };
    expect(processEnvironment(['crm'], secrets, derived).environment.PARTY_REGISTRY_DATABASE_URL).toBeUndefined();
    expect(processEnvironment([PARTY_REGISTRY], secrets, derived).environment.PARTY_REGISTRY_DATABASE_URL).toBe(
      'postgres://registry',
    );
  });

  it('merges the owner secrets of every served owner', () => {
    const secrets = {
      crm: { CRM_KEY: 'crm-value' },
      [PARTY_REGISTRY]: { REGISTRY_KEY: 'registry-value' },
    };
    const { conflicts, environment } = processEnvironment(['crm', PARTY_REGISTRY], secrets, derived);
    expect(conflicts).toEqual([]);
    expect(environment.CRM_KEY).toBe('crm-value');
    expect(environment.REGISTRY_KEY).toBe('registry-value');
  });

  it('lets the host-derived value override a stored host-controlled key', () => {
    const secrets = { crm: { ONTOS_GATEWAY_ISSUER: 'https://stored.example.com' } };
    expect(processEnvironment(['crm'], secrets, derived).environment.ONTOS_GATEWAY_ISSUER).toBe(ORIGIN);
  });

  it('reports keys that two owners of one process store with different values', () => {
    const secrets = {
      crm: { SHARED_KEY: 'one' },
      [PARTY_REGISTRY]: { SHARED_KEY: 'two' },
    };
    expect(processEnvironment(['crm', PARTY_REGISTRY], secrets, derived).conflicts).toEqual(['SHARED_KEY']);
  });
});

const STOREFRONT = 'https://akros.example';
/** Owner runtime keys are derived from the shared configuration, so read them as entries of the overlay. */
const derivedValue = (derived: ReturnType<typeof derivedEnvironment>, key: string) =>
  new Map<string, unknown>(Object.entries(derived)).get(key);

describe('derivedEnvironment', () => {
  it('uses the public origin as the issuer and auth URL', () => {
    const derivedValues = derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map([['price-group-catalog', 4204]]));
    expect(derivedValues.ONTOS_GATEWAY_ISSUER).toBe(ORIGIN);
    expect(derivedValues.BETTER_AUTH_URL).toBe(ORIGIN);
    expect(derivedValues.ONTOS_OAUTH_ISSUER).toBe(`${ORIGIN}/shell-super-app-api/oauth`);
    expect(derivedValues.COMMERCE_PORTAL_AUTH_URL).toBe(STOREFRONT);
    expect(derivedValue(derivedValues, 'ONTOS_PRICE_GROUP_CATALOG_BASE_URL')).toBe(
      'http://127.0.0.1:4204/price-group-catalog-api',
    );
  });

  it('binds each owner API dependency to its serving unit on loopback and leaves unserved ones unset', () => {
    const derivedValues = derivedEnvironment(
      ORIGIN,
      STOREFRONT,
      3000,
      new Map([
        ['commerce-customer-context', 4103],
        ['commerce-cart', 4115],
      ]),
    );
    expect(derivedValue(derivedValues, 'ONTOS_COMMERCE_CART_API_BASE_URL')).toBe(
      'http://127.0.0.1:4115/commerce-cart-api',
    );
    expect(derivedValue(derivedValues, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL')).toBe(
      'http://127.0.0.1:4103/commerce-customer-context-api',
    );
    expect(derivedValues.ONTOS_SHELL_GATEWAY_BASE_URL).toBe('http://127.0.0.1:3020/shell-super-app-api');
    // An owner this environment does not serve gets no base, so a stored owner secret cannot point elsewhere.
    expect(new Map(Object.entries(derivedValues)).has('ONTOS_COMMERCE_ORDER_API_BASE_URL')).toBe(true);
    expect(derivedValue(derivedValues, 'ONTOS_COMMERCE_ORDER_API_BASE_URL')).toBeUndefined();
    expect(derivedValue(derivedValues, 'ONTOS_PRICE_GROUP_CATALOG_BASE_URL')).toBeUndefined();
    expect(derivedValue(derivedValues, 'ONTOS_ORDER_FINALIZATION_WORKER_AUTHENTICATION_NAMESPACE_ID')).toBe(
      'ontos.staff.better-auth.v1',
    );
    expect(derivedValue(derivedValues, 'ONTOS_PRICING_ORDER_NAMESPACE_ID')).toBe('ontos.staff.better-auth.v1');
  });

  it('points the composition source at the host loopback port', () => {
    expect(derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map()).ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(
      'http://127.0.0.1:3000/_host/composition',
    );
  });
});

describe('ownerEntrySource', () => {
  const generated = [
    "import app from '/abs/app/node_modules/x/y.js';",
    "import { thing } from 'pkg/sub';",
    "import { createRequire } from 'node:module';",
    'async function main() {',
    '  const port = process.env.PORT || 8080;',
    '  await app.listen({',
    '    port,',
    '  });',
    '}',
    'main();',
    '',
  ].join('\n');

  it('exports start(port) without the trailing main call', () => {
    const source = ownerEntrySource(generated, DIST, resolvePackage);
    expect(source).toContain('export async function start(port) {');
    expect(source).not.toContain('main();');
    expect(source).not.toContain('const port = process.env.PORT');
  });

  it('binds the loopback host only', () => {
    const source = ownerEntrySource(generated, DIST, resolvePackage);
    expect(source).toContain("app.listen({ host: '127.0.0.1',");
  });

  it('rewrites imports relative to the dist directory', () => {
    const source = ownerEntrySource(generated, DIST, resolvePackage);
    expect(source).toContain("import app from '../node_modules/x/y.js';");
    expect(source).toContain("import { thing } from '../node_modules/pkg/sub/index.js';");
    expect(source).toContain("import { createRequire } from 'node:module';");
  });

  it('returns undefined for an unexpected entry shape', () => {
    expect(ownerEntrySource('export const unrelated = 1;\n', DIST, resolvePackage)).toBeUndefined();
  });
});
