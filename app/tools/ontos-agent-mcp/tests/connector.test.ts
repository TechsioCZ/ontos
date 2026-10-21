import { describe, expect, it } from '@rstest/core';
import { createConnectionDescriber } from '../src/oauth/connector.ts';
import { ConnectionInactiveError, ConnectorUnavailableError } from '../src/oauth/types.ts';
import type { ConnectionDescription, VerifiedAccessToken } from '../src/oauth/types.ts';

const TOKEN: VerifiedAccessToken = {
  clientId: 'client-1',
  expiresAt: 2_000_000_000,
  grantId: 'grant-1',
  scopes: ['ontos'],
  subject: 'user-1',
  token: 'jwt-1',
};

const DESCRIPTION: ConnectionDescription = {
  acting: { displayName: 'Petra Správcová', kind: 'human', principalId: 'principal-1' },
  client: { clientId: 'client-1', host: 'claude.ai', kind: 'cimd', name: 'Claude' },
  compositionRevision: 'a'.repeat(64),
  delegatedBy: null,
  grantId: 'grant-1',
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  legalName: 'Siampark',
  modules: [{ label: 'Úkoly', moduleId: 'work.tasks', read: true, write: true }],
  profileId: 'profile-1',
  status: 'active',
  tenantId: 'tenant-1',
  writePolicy: 'approval',
};

const CONFIG = { connectorSecret: 'secret-1', shellInternalUrl: 'http://shell.test' };

type Reply = { status: number; body?: unknown } | 'network';

const harness = (replies: Reply[]) => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === 'network') {
      throw new TypeError('fetch failed');
    }
    return Response.json(reply.body ?? {}, { status: reply.status });
  }) as typeof fetch;
  const describeConnection = createConnectionDescriber({ config: CONFIG, fetchFn });
  return { calls, describeConnection };
};

const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('connection describer', () => {
  it('asks the shell on every request, so a change applies to the next one', async () => {
    const h = harness([{ status: 200, body: DESCRIPTION }, { status: 401 }]);
    expect(await h.describeConnection(TOKEN)).toEqual(DESCRIPTION);
    expect(await errorOf(h.describeConnection(TOKEN))).toBeInstanceOf(ConnectionInactiveError);
    expect(h.calls.length).toBe(2);
  });

  it('maps 5xx and network errors to unavailable', async () => {
    const serverError = harness([{ status: 503 }]);
    expect(await errorOf(serverError.describeConnection(TOKEN))).toBeInstanceOf(ConnectorUnavailableError);
    const network = harness(['network']);
    expect(await errorOf(network.describeConnection(TOKEN))).toBeInstanceOf(ConnectorUnavailableError);
  });

  it('rejects a description of another grant', async () => {
    const h = harness([{ status: 200, body: { ...DESCRIPTION, grantId: 'grant-2' } }]);
    expect(await errorOf(h.describeConnection(TOKEN))).toBeInstanceOf(ConnectionInactiveError);
  });

  it('sends connector secret and user token', async () => {
    const h = harness([{ status: 200, body: DESCRIPTION }]);
    await h.describeConnection(TOKEN);
    expect(h.calls[0].url).toBe('http://shell.test/shell-super-app-api/auth/connector/describe');
    expect(h.calls[0].headers.get('x-ontos-connector-key')).toBe('secret-1');
    expect(h.calls[0].headers.get('authorization')).toBe('Bearer jwt-1');
  });

  it('rejects a malformed body', async () => {
    const h = harness([{ status: 200, body: { grantId: 'grant-1' } }]);
    expect(await errorOf(h.describeConnection(TOKEN))).toBeInstanceOf(ConnectorUnavailableError);
  });
});
