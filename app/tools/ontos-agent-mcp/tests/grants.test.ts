// Principal capabilities from a mocked shell. No shell is contacted.
// Run: pnpm --filter @ontos/agent-mcp test
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from '@rstest/core';
import type { Catalog } from '../src/capabilities/types.ts';
import type { PrincipalSession } from '../src/session.ts';

const SHELL = 'http://shell.test';
const REVISION = 'a'.repeat(64);
const OBCHOD = '71000000-0000-4000-8000-000000000020';
process.env.ONTOS_AGENT_API_KEY = 'test-agent-key';
process.env.ONTOS_SHELL_URL = SHELL;
process.env.ONTOS_COMPOSITION_REVISION = REVISION;

const { clearCapabilityCache, detectWrite, principalIdFromToken, resolveCapabilities } = await import(
  '../src/capabilities/grants.ts'
);

const CAPABILITY_URL = `${SHELL}/shell-super-app-api/auth/api-key/capabilities`;
const GATEWAY_URL = `${SHELL}/shell-super-app-api/auth/api-key/gateway-context`;
const ROUTE_PATTERN = /\/shell-super-app-api\/module-api\/(?<vertical>[^/]+)\/[^/]+\/[^/]+-api(?<path>\/.*)$/u;

const json = (status: number, body: unknown): Response =>
  Response.json(body, { headers: { 'content-type': 'application/json' }, status });

const tokenFor = (principalId: string): string =>
  `h.${Buffer.from(JSON.stringify({ principal: { principalId } })).toString('base64url')}.s`;

interface Mocks {
  /** Answer for the shell capability endpoint. */
  readonly capability?: () => Response;
  /** Gateway-context answer per legalEntityId; defaults to 403 for every company. */
  readonly gateway: (legalEntityId: string | undefined) => Response;
  /** Vertical read answer by "<vertical> <path>". */
  readonly reads: Readonly<Record<string, () => Response>>;
}

const installFetch = (mocks: Mocks): void => {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body: Record<string, unknown> = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (url === CAPABILITY_URL) {
      return mocks.capability?.() ?? json(404, {});
    }
    if (url === GATEWAY_URL) {
      const audience = String(body['audience']);
      const legalEntityId = typeof body['legalEntityId'] === 'string' ? body['legalEntityId'] : undefined;
      const answer = mocks.gateway(legalEntityId);
      if (answer.status !== 200) {
        return answer;
      }
      return json(200, {
        apiBaseUrl: `/shell-super-app-api/module-api/${audience}/build1/${audience}-api`,
        compositionRevision: REVISION,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        token: tokenFor('p-1'),
      });
    }
    const match = ROUTE_PATTERN.exec(url);
    if (match === null) {
      throw new Error(`unexpected URL ${url}`);
    }
    const key = `${match.groups?.['vertical'] ?? ''} ${match.groups?.['path'] ?? ''}`;
    const read = mocks.reads[key];
    if (read === undefined) {
      throw new Error(`no route for ${key}`);
    }
    return read();
  };
};

const gatewayOnlyFor =
  (allowed: string) =>
  (legalEntityId: string | undefined): Response =>
    legalEntityId === allowed
      ? json(200, {})
      : json(403, { detail: 'The authenticated principal cannot use the requested gateway context.' });

const catalog: Catalog = {
  compositionRevision: REVISION,
  modules: [
    {
      appId: 'siampark-work',
      displayName: 'siampark.work',
      moduleId: 'siampark.work',
      actions: [],
      probeReadSlug: 'records',
      reads: [],
      supportsAiProposals: false,
      typedTools: true,
    },
    {
      appId: 'crm',
      displayName: 'demo.crm',
      moduleId: 'demo.crm',
      actions: [],
      probeReadSlug: 'records',
      reads: [],
      supportsAiProposals: false,
      typedTools: true,
    },
    {
      appId: 'party-registry',
      displayName: 'party.registry',
      moduleId: 'party.registry',
      actions: [],
      probeReadSlug: 'customer-list',
      reads: [],
      supportsAiProposals: false,
      typedTools: true,
    },
  ],
  warnings: [],
};

const session: PrincipalSession = {
  apiKey: 'k1',
  label: 'test',
  legalEntityId: undefined,
  transport: 'http',
  writePolicyOverride: undefined,
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearCapabilityCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCapabilityCache();
});

describe('resolveCapabilities', () => {
  it('probes gateway membership and module reads when the capability endpoint is absent', async () => {
    installFetch({
      gateway: gatewayOnlyFor(OBCHOD),
      reads: {
        'siampark-work /reads/records': () => json(200, { canWrite: true, revision: 1 }),
        'crm /reads/records': () => json(403, { code: 'read_permission_denied', detail: 'x' }),
        'party-registry /reads/customer-list': () => json(200, { items: [] }),
      },
    });

    const result = await resolveCapabilities(session, catalog);

    assert.equal(result.source, 'probe');
    assert.equal(result.principalId, 'p-1');
    assert.equal(result.writePolicy, 'direct');
    assert.equal(result.companies.length, 1);
    const [company] = result.companies;
    assert.equal(company?.label, 'Obchodní firma');
    const byModule = Object.fromEntries((company?.modules ?? []).map((module) => [module.moduleId, module]));
    assert.equal(byModule['siampark.work']?.read, 'allowed');
    assert.equal(byModule['siampark.work']?.write, 'allowed');
    assert.equal(byModule['demo.crm']?.read, 'denied');
    assert.equal(byModule['demo.crm']?.write, 'denied');
    assert.equal(byModule['party.registry']?.read, 'allowed');
    assert.equal(byModule['party.registry']?.write, 'unknown');
  });

  it('uses the capability endpoint when it answers and applies the approval override', async () => {
    installFetch({
      capability: () =>
        json(200, {
          companies: [
            {
              legalEntityId: OBCHOD,
              legalName: 'Obchodní firma',
              modules: [{ moduleId: 'siampark.work', read: true, write: true }],
            },
          ],
          principal: { displayName: 'Obchodní agent', kind: 'agent', principalId: 'p-2' },
          writePolicy: 'direct',
        }),
      gateway: () => json(403, {}),
      reads: {},
    });

    const result = await resolveCapabilities({ ...session, writePolicyOverride: 'approval' }, catalog);

    assert.equal(result.source, 'endpoint');
    assert.equal(result.principalId, 'p-2');
    assert.equal(result.writePolicy, 'approval');
    const [company] = result.companies;
    const byModule = Object.fromEntries((company?.modules ?? []).map((module) => [module.moduleId, module]));
    assert.equal(byModule['siampark.work']?.write, 'allowed');
    assert.equal(byModule['demo.crm']?.read, 'denied');
  });

  it('rejects when the gateway answers 401 for every company', async () => {
    installFetch({
      gateway: () => json(401, { detail: 'revoked' }),
      reads: {},
    });

    await assert.rejects(resolveCapabilities(session, catalog), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/u);
      return true;
    });
  });
});

describe('detectWrite', () => {
  it('reads canWrite, the CRM viewer grants and the operations agenda flags', () => {
    assert.deepEqual(detectWrite('siampark.work', { canWrite: false }).write, 'denied');
    assert.deepEqual(detectWrite('demo.crm', { viewer: { writeAll: false, writeAssigned: true } }).write, 'allowed');
    assert.deepEqual(
      detectWrite('demo.siampark-ops', { access: [{ canWrite: false }, { canWrite: true }] }).write,
      'allowed',
    );
    assert.deepEqual(detectWrite('party.registry', {}).write, 'unknown');
  });
});

describe('principalIdFromToken', () => {
  it('reads the principal id from the assertion payload and returns undefined for garbage', () => {
    assert.equal(principalIdFromToken(tokenFor('p-9')), 'p-9');
    assert.equal(principalIdFromToken(`h.${Buffer.from('{"sub":"s-1"}').toString('base64url')}.s`), 's-1');
    assert.equal(principalIdFromToken('not-a-token'), undefined);
  });
});
