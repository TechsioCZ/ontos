import { Duration, Effect, Option, Ref } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import {
  awaitSupersedingRevision,
  CONTROL_PORT,
  derivedEnvironment,
  finiteProcessEnvironment,
  hostApplication,
  hostControlApplication,
  processEnvironment,
  relayResponseHeaders,
  moduleCredentialCallersOf,
  routeRequest,
} from '../zerops/app-host.mts';
import { hostedUnits } from '../zerops/hosted-units.mts';
import { makeHostRefusalLog } from '../zerops/host-refusal-log.mts';
import { makeSupersedeDrain } from '../zerops/supersede-drain.mts';
import type { ReleaseIntent, Topology } from '../zerops/hosted-units.mts';
import { ownerEntrySource } from '../zerops/owner-entry.mts';

const PARTY_REGISTRY = 'party-registry';
const SHELL_ID = 'shell-super-app';
const COMMERCE_CUSTOMER_CONTEXT = 'commerce-customer-context';
const ORIGIN = 'https://ontos.example.com';
const DIST = '/abs/app/dist';
const resolvePackage = (specifier: string) => `/abs/app/node_modules/${specifier}/index.js`;

it.effect('rejects credential URLs and native login POSTs at the public host before forwarding to any owner', () =>
  Effect.gen(function* publicCredentialGuard() {
    const published = yield* Ref.make(false);
    for (const [method, path] of [
      ['GET', '/cs/login?login=x&password=y'],
      ['GET', '/shell-super-app-api/oauth?client_secret=y'],
      ['GET', '/_m/crm/private?api_key=y'],
      ['POST', '/en/login'],
    ] as const) {
      const response = yield* hostApplication(
        new Map(),
        published,
        Effect.succeed(Option.none()),
        makeHostRefusalLog(),
        makeSupersedeDrain(),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`https://stage.test${path}`, { method })),
        ),
      );
      expect(response.status).toBe(303);
      expect(response.headers.location).toBe(path.startsWith('/en/') ? '/en/login' : '/cs/login');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
  }),
);

const requestAt = (path: string) =>
  Effect.provideService(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request(`http://127.0.0.1${path}`)),
  );

it.effect('the control port answers probes from the start and never serves application traffic', () =>
  Effect.gen(function* controlPort() {
    const published = yield* Ref.make(false);
    const control = hostControlApplication(published, Effect.succeed(Option.none()), makeHostRefusalLog());
    expect((yield* control.pipe(requestAt('/_host/live'))).status).toBe(200);
    expect((yield* control.pipe(requestAt('/_host/ready'))).status).toBe(503);
    for (const path of ['/shell-super-app-api/auth/api-key/gateway-read', '/cs', '/_m/crm/mf-manifest.json']) {
      expect((yield* control.pipe(requestAt(path))).status).toBe(404);
    }
    yield* Ref.set(published, true);
    expect((yield* control.pipe(requestAt('/_host/ready'))).status).toBe(200);
  }),
);

it.live('a host notices the release that replaced it, ignoring failed reads and its own revision', () =>
  Effect.gen(function* supersedingRevision() {
    const answers: readonly Effect.Effect<Option.Option<string>, string>[] = [
      Effect.succeed(Option.some('own')),
      Effect.fail('database unavailable'),
      Effect.succeed(Option.none()),
      Effect.succeed(Option.some('own')),
      Effect.succeed(Option.some('newer')),
    ];
    const reads = yield* Ref.make(0);
    const activeRevision = Ref.getAndUpdate(reads, (count) => count + 1).pipe(
      Effect.flatMap((count) => answers[Math.min(count, answers.length - 1)] ?? Effect.die('no answer')),
    );
    expect(yield* awaitSupersedingRevision('own', activeRevision, Duration.millis(1))).toBe('newer');
    expect(yield* Ref.get(reads)).toBe(answers.length);
  }),
);

describe('relayResponseHeaders', () => {
  it('closes the caller connection on an unavailable owner answer so its retry can reach another container', () => {
    const upstream = { connection: 'keep-alive', 'content-type': 'application/json', 'keep-alive': 'timeout=5' };
    expect(relayResponseHeaders(503, upstream)).toStrictEqual({
      connection: 'close',
      'content-type': 'application/json',
    });
  });

  it('never passes on the drain headers only a host sets', () => {
    expect(
      relayResponseHeaders(200, { etag: '"a"', 'x-ontos-drain-forwarded': '1', 'x-ontos-drain-refused': 'draining' }),
    ).toStrictEqual({ etag: '"a"' });
  });

  it('keeps the caller connection reusable for every other answer and drops hop-by-hop headers', () => {
    expect(relayResponseHeaders(200, { connection: 'keep-alive', etag: '"a"' })).toStrictEqual({
      etag: '"a"',
    });
  });
});

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

  it('keeps owner document routes reachable for lazy rendering', () => {
    expect(Option.getOrUndefined(routeRequest('/_m/crm/cs', owners))).toEqual({ path: '/cs', port: 4125 });
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
const SHOP = 'https://shop.example';
/** Owner runtime keys are derived from the shared configuration, so read them as entries of the overlay. */
const derivedValue = (derived: ReturnType<typeof derivedEnvironment>, key: string) =>
  new Map<string, unknown>(Object.entries(derived)).get(key);

describe('derivedEnvironment', () => {
  it('uses immutable release metadata without compression probes or production debug request logs', () => {
    const derivedValues = derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map(), SHOP);
    expect(derivedValues.MODERN_SERVER_IMMUTABLE_ASSETS).toBe('true');
    expect(derivedValues.MODERN_SERVER_PRECOMPRESSED_ASSETS).toBe('false');
    expect(derivedValues.MODERN_SERVER_LOG_LEVEL).toBe('info');
    const secrets = {
      crm: { MODERN_SERVER_IMMUTABLE_ASSETS: 'false' },
      [PARTY_REGISTRY]: { MODERN_SERVER_IMMUTABLE_ASSETS: 'different' },
    };
    const hosted = processEnvironment(['crm', PARTY_REGISTRY], secrets, derivedValues);
    expect(hosted.conflicts).toEqual([]);
    expect(hosted.environment.MODERN_SERVER_IMMUTABLE_ASSETS).toBe('true');
  });

  it('trusts both storefront hosts for sign-in, names the portal by the AKROS host and links demo e-mails to the shop', () => {
    const derivedValues = derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map(), SHOP);
    expect(derivedValues.BETTER_AUTH_TRUSTED_ORIGINS).toBe(`${ORIGIN},${STOREFRONT},${SHOP}`);
    expect(derivedValues.COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS).toBe(`${ORIGIN},${STOREFRONT},${SHOP}`);
    expect(derivedValues.COMMERCE_PORTAL_AUTH_URL).toBe(STOREFRONT);
    expect(derivedValues.AKROS_STOREFRONT_PUBLIC_URL).toBe(SHOP);
  });

  it('adds only the two approved N1 origins to the Stage Commerce Portal realm', () => {
    const derivedValues = derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map(), SHOP, 'stage');
    const portalOrigins = derivedValues.COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS.split(',');
    expect(portalOrigins).toEqual([
      ORIGIN,
      STOREFRONT,
      SHOP,
      'https://ontos-stage-n1.web-revolution.cz',
      'http://localhost:3071',
    ]);
    for (const unapproved of [
      '*',
      'http://127.0.0.1:3071',
      'http://localhost:3070',
      'http://localhost:3072',
      'https://unapproved.example',
    ]) {
      expect(portalOrigins).not.toContain(unapproved);
    }
    expect(derivedValues.BETTER_AUTH_TRUSTED_ORIGINS).toBe(`${ORIGIN},${STOREFRONT},${SHOP}`);
  });

  it('keeps the approved Stage Portal origins authoritative over stored owner origin overrides', () => {
    const derivedValues = derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map(), SHOP, 'stage');
    const hosted = processEnvironment(
      [COMMERCE_CUSTOMER_CONTEXT],
      {
        [COMMERCE_CUSTOMER_CONTEXT]: {
          BETTER_AUTH_TRUSTED_ORIGINS: '*',
          COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: 'https://unapproved.example,http://127.0.0.1:3071,*',
          COMMERCE_PORTAL_AUTH_URL: 'https://unapproved.example',
        },
      },
      derivedValues,
    );
    expect(hosted.conflicts).toEqual([]);
    expect(hosted.environment.COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS).toBe(
      `${ORIGIN},${STOREFRONT},${SHOP},https://ontos-stage-n1.web-revolution.cz,http://localhost:3071`,
    );
    expect(hosted.environment.BETTER_AUTH_TRUSTED_ORIGINS).toBe(`${ORIGIN},${STOREFRONT},${SHOP}`);
    expect(hosted.environment.COMMERCE_PORTAL_AUTH_URL).toBe(STOREFRONT);
  });

  it('does not add N1 Stage origins for missing or non-stage deployment environments', () => {
    for (const environment of [undefined, '', 'production', 'development', 'staging', 'stage ', 'STAGE']) {
      const derivedValues = derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map(), SHOP, environment);
      expect(derivedValues.COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS).toBe(`${ORIGIN},${STOREFRONT},${SHOP}`);
      expect(derivedValues.BETTER_AUTH_TRUSTED_ORIGINS).toBe(`${ORIGIN},${STOREFRONT},${SHOP}`);
    }
  });

  it('retains every other host-derived value when enabling the approved Stage Portal origins', () => {
    const ports = new Map([
      [COMMERCE_CUSTOMER_CONTEXT, 4103],
      ['commerce-cart', 4115],
    ]);
    const original = derivedEnvironment(ORIGIN, STOREFRONT, 3000, ports, SHOP);
    const stage = derivedEnvironment(ORIGIN, STOREFRONT, 3000, ports, SHOP, 'stage');
    for (const [key, value] of Object.entries(original)) {
      if (key !== 'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS') {
        expect(derivedValue(stage, key)).toEqual(value);
      }
    }
    expect(Object.keys(stage)).toEqual(Object.keys(original));
  });

  it('uses the public origin as the issuer and auth URL', () => {
    const derivedValues = derivedEnvironment(ORIGIN, STOREFRONT, 3000, new Map([['price-group-catalog', 4204]]), SHOP);
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
        [COMMERCE_CUSTOMER_CONTEXT, 4103],
        ['commerce-cart', 4115],
      ]),
      SHOP,
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
    // Module calls carry the Shell-signed calling module, never a configured API-key caller namespace.
    expect(Object.keys(derivedValues).some((key) => key.endsWith('NAMESPACE_ID'))).toBe(false);
  });

  it('points the composition source at the loopback control port, which is open before the public port', () => {
    expect(CONTROL_PORT).toBe(3001);
    expect(
      derivedEnvironment(ORIGIN, STOREFRONT, CONTROL_PORT, new Map(), SHOP).ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL,
    ).toBe('http://127.0.0.1:3001/_host/composition');
  });
});

describe('ownerEntrySource', () => {
  const createUnitServer = '  const app = await createProdServer(prodServerOptions);';
  const generated = [
    "import app from '/abs/app/node_modules/x/y.js';",
    "import { thing } from 'pkg/sub';",
    "import { createRequire } from 'node:module';",
    'async function main() {',
    createUnitServer,
    '  const port = process.env.PORT || 8080;',
    '  await app.listen({',
    '    port,',
    '  });',
    '}',
    'main();',
    '',
  ].join('\n');

  it('exports start(port, configureServer) without the trailing main call', () => {
    const source = ownerEntrySource(generated, DIST, resolvePackage);
    expect(source).toContain('export async function start(port, configureServer) {');
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

  it('hands the unit server to configureServer before it listens', () => {
    const source = ownerEntrySource(generated, DIST, resolvePackage) ?? '';
    const configured = source.indexOf('configureServer(app);');
    expect(configured).toBeGreaterThan(source.indexOf(createUnitServer.trim()));
    expect(configured).toBeLessThan(source.indexOf('app.listen('));
  });

  it('returns undefined for an unexpected entry shape', () => {
    expect(ownerEntrySource('export const unrelated = 1;\n', DIST, resolvePackage)).toBeUndefined();
    // Without the server construction the host could not configure its keep-alive.
    expect(ownerEntrySource(generated.replace(`${createUnitServer}\n`, ''), DIST, resolvePackage)).toBeUndefined();
  });
});

describe('moduleCredentialCallersOf', () => {
  it('gives a module credential only to hosted owners that call other modules', () => {
    const commerceOrder = 'commerce-order';
    expect(moduleCredentialCallersOf([commerceOrder, 'workforce', PARTY_REGISTRY, 'tagging'])).toEqual([
      commerceOrder,
      PARTY_REGISTRY,
    ]);
    expect(moduleCredentialCallersOf([SHELL_ID])).toEqual([]);
  });
});
