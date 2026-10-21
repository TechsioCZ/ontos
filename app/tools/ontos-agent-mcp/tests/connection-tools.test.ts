// Connection tools per grant: generic + typed tools against a fake fetch. No shell or network is contacted.
// Run: pnpm --dir tools/ontos-agent-mcp exec rstest run tests/connection-tools.test.ts
import assert from 'node:assert/strict';
import { describe, it } from '@rstest/core';
import type { Catalog, CatalogAction, CatalogModule, CatalogRead } from '../src/capabilities/types.ts';
import type { ConnectionDescription, ConnectionWritePolicy, RsConfig } from '../src/oauth/types.ts';
import { buildConnectionTools } from '../src/mcp/tools.ts';
import type { ToolSpec } from '../src/mcp/types.ts';
import type { OAuthConnectionSession } from '../src/session.ts';

const workRead: CatalogRead = {
  appId: 'work-tasks',
  id: 'work.tasks/read/records',
  inputSchema: { type: 'object' },
  kind: 'read',
  moduleId: 'work.tasks',
  slug: 'records',
  toolName: 'work_tasks__read_records',
};
const createTask: CatalogAction = {
  actionSlug: 'apply-command',
  appId: 'work-tasks',
  commandTag: 'CreateTask',
  id: 'work.tasks/command/CreateTask',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  kind: 'action',
  moduleId: 'work.tasks',
  proposable: true,
  toolName: 'work_tasks__create_task',
};
const cancelTask: CatalogAction = {
  ...createTask,
  commandTag: 'CancelTask',
  id: 'work.tasks/command/CancelTask',
  proposable: false,
  toolName: 'work_tasks__cancel_task',
};
const aiPropose: CatalogAction = {
  ...createTask,
  commandTag: 'AiProposeChanges',
  id: 'work.tasks/command/AiProposeChanges',
  proposable: false,
  toolName: 'work_tasks__ai_propose_changes',
};
const crmRead: CatalogRead = {
  appId: 'crm',
  id: 'demo.crm/read/records',
  inputSchema: { type: 'object' },
  kind: 'read',
  moduleId: 'demo.crm',
  slug: 'records',
  toolName: 'crm__read_records',
};
const updateClient: CatalogAction = {
  actionSlug: 'apply-command',
  appId: 'crm',
  commandTag: 'UpdateClient',
  id: 'demo.crm/command/UpdateClient',
  inputSchema: { type: 'object' },
  kind: 'action',
  moduleId: 'demo.crm',
  proposable: true,
  toolName: 'crm__update_client',
};
const moduleOf = (
  moduleId: string,
  appId: string,
  reads: CatalogRead[],
  actions: CatalogAction[],
): CatalogModule => ({
  actions,
  appId,
  displayName: moduleId,
  moduleId,
  probeReadSlug: 'records',
  reads,
  supportsAiProposals: true,
  typedTools: true,
});
const CATALOG: Catalog = {
  compositionRevision: 'a'.repeat(64),
  modules: [
    moduleOf('work.tasks', 'work-tasks', [workRead], [createTask, cancelTask, aiPropose]),
    moduleOf('demo.crm', 'crm', [crmRead], [updateClient]),
  ],
  warnings: [],
};

const CONFIG: RsConfig = {
  allowedHosts: [],
  allowedOrigins: [],
  connectGuideUrl: 'http://localhost:3020/cs/profil',
  connectorSecret: 'secret-1',
  host: '127.0.0.1',
  issuer: 'http://localhost:3020/shell-super-app-api/oauth',
  jwksUrl: 'http://localhost:3020/shell-super-app-api/oauth/jwks',
  port: 0,
  prmUrl: 'http://localhost:3090/.well-known/oauth-protected-resource/mcp',
  resourceUrl: 'http://localhost:3090/mcp',
  shellInternalUrl: 'http://shell.test',
  shellPublicUrl: 'http://localhost:3020',
};

const SESSION: OAuthConnectionSession = {
  accessToken: 'jwt-1',
  connectorSecret: 'secret-1',
  grantId: 'grant-1',
  kind: 'oauth_connection',
  label: 'test',
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  transport: 'http',
  writePolicyOverride: undefined,
};

const describe_ = (writePolicy: ConnectionWritePolicy, write = true): ConnectionDescription => ({
  acting: { displayName: 'Petra Správcová', kind: 'human', principalId: 'principal-1' },
  client: { clientId: 'client-1', host: 'claude.ai', kind: 'cimd', name: 'Claude' },
  compositionRevision: 'a'.repeat(64),
  delegatedBy: null,
  grantId: 'grant-1',
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  legalName: 'Siampark',
  modules: [{ label: 'Úkoly', moduleId: 'work.tasks', read: true, write }],
  profileId: 'profile-1',
  status: 'active',
  tenantId: 'tenant-1',
  writePolicy,
});

interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly legalEntityId: string;
    readonly proposals: readonly { readonly command: Record<string, unknown> }[];
  };
}

const PROPOSALS_URL = 'http://shell.test/shell-super-app-api/agent-platform/proposals';

const fakeFetch = () => {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== PROPOSALS_URL) {
      throw new Error(`unexpected fetch ${url}`);
    }
    requests.push({
      body: JSON.parse(String(init?.body)) as RecordedRequest['body'],
      headers: { ...(init?.headers as Record<string, string>) },
      url,
    });
    return Response.json({
      batchId: 'batch-1',
      proposalIds: ['proposal-1'],
      replayed: false,
      reviewPath: '/cs/sprava/ke-schvaleni',
    });
  }) as typeof fetch;
  return { fetchFn, requests };
};

const build = async (writePolicy: ConnectionWritePolicy, fetchFn: typeof fetch) =>
  buildConnectionTools(
    { description: describe_(writePolicy), session: SESSION, token: undefined },
    { config: CONFIG, fetchFn, getCatalog: async () => CATALOG },
  );

const tool = (tools: readonly ToolSpec[], name: string): ToolSpec => {
  const found = tools.find((spec) => spec.name === name);
  if (found === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return found;
};

const textOf = (result: { readonly content: readonly { readonly text: string }[] }): string =>
  result.content.map((part) => part.text).join('\n');

describe('buildConnectionTools', () => {
  it('offers write tools only where the policy allows them', async () => {
    const { fetchFn } = fakeFetch();
    const readOnly = (await build('read_only', fetchFn)).map((spec) => spec.name);
    assert.ok(!readOnly.includes('ontos_execute'));
    assert.ok(!readOnly.includes('ontos_propose'));
    for (const policy of ['approval', 'direct'] as const) {
      const names = (await build(policy, fetchFn)).map((spec) => spec.name);
      assert.ok(names.includes('ontos_execute'));
      assert.ok(names.includes('ontos_propose'));
    }
  });

  it('ontos_whoami reports the profile and the write policy', async () => {
    const { fetchFn } = fakeFetch();
    const tools = await build('approval', fetchFn);
    const result = await tool(tools, 'ontos_whoami').handler({});
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.['profile_id'], 'profile-1');
    assert.equal(result.structuredContent?.['writePolicy'], 'approval');
  });

  it('approval ontos_execute submits a proposal with connector headers and the command tag', async () => {
    const { fetchFn, requests } = fakeFetch();
    const tools = await build('approval', fetchFn);
    const result = await tool(tools, 'ontos_execute').handler({
      id: 'work.tasks/command/CreateTask',
      input: { title: 'Test' },
      reason: 'Důvod testu',
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.['status'], 'proposed');
    assert.equal(result.structuredContent?.['proposalId'], 'proposal-1');
    assert.equal(result.structuredContent?.['reviewUrl'], 'http://localhost:3020/cs/sprava/ke-schvaleni');
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.ok(request !== undefined);
    assert.equal(request.headers['x-ontos-connector-key'], 'secret-1');
    assert.equal(request.headers['authorization'], 'Bearer jwt-1');
    assert.equal(request.body.proposals[0]?.command['_tag'], 'CreateTask');
    assert.equal(request.body.legalEntityId, '71000000-0000-4000-8000-000000000021');
  });

  it('direct ontos_execute outside the grant says the connection may not change the module', async () => {
    const { fetchFn } = fakeFetch();
    const tools = await build('direct', fetchFn);
    const result = await tool(tools, 'ontos_execute').handler({ id: 'demo.crm/command/UpdateClient', input: {} });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('nesmí měnit'));
  });

  it('ontos_read outside the grant says the connection has no access', async () => {
    const { fetchFn } = fakeFetch();
    const tools = await build('direct', fetchFn);
    const result = await tool(tools, 'ontos_read').handler({ id: 'demo.crm/read/records' });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('nemá přístup'));
  });

  it('AI meta commands are never callable through MCP', async () => {
    const { fetchFn } = fakeFetch();
    const tools = await build('direct', fetchFn);
    const result = await tool(tools, 'ontos_execute').handler({ id: 'work.tasks/command/AiProposeChanges' });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Tuto akci nelze volat přes MCP.');
  });
});
