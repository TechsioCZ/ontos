// Generic read/execute operations against a mocked fetch. No shell is contacted.
// Run: pnpm --dir tools/ontos-agent-mcp exec rstest run tests/operations.test.ts
import assert from 'node:assert/strict';
import { describe } from '@rstest/core';
import { it } from 'effect-rstest';
import { Effect } from 'effect';
import { z } from 'zod';
import type { Catalog, CatalogAction, CatalogModule, CatalogRead } from '../src/capabilities/types.ts';
import type { PrincipalSession } from '../src/session.ts';

const SHELL = 'http://shell.test';
const REVISION = 'a'.repeat(64);
process.env.ONTOS_AGENT_API_KEY = 'test-agent-key';
process.env.ONTOS_SHELL_URL = SHELL;
process.env.ONTOS_COMPOSITION_REVISION = REVISION;

const { findEntry, runExecute, runRead, shapeReadResult } = await import('../src/operations.ts');

/** A JSON object body, decoded from the request or response text. */
const BodySchema = z.record(z.string(), z.unknown());
type Body = z.infer<typeof BodySchema>;

interface Reply {
  readonly body: Body;
  readonly status?: number;
}

interface Call {
  readonly auth: string | null;
  readonly body: Body;
  readonly idempotencyKey: string | null;
  readonly path: string;
  readonly vertical: string;
}

type Route = (call: Call) => Reply;

const ROUTE_PATTERN = /\/shell-super-app-api\/module-api\/(?<vertical>[^/]+)\/[^/]+\/[^/]+-api(?<path>\/.*)$/u;
const expiresAt = () => Math.floor(Date.now() / 1000) + 3600;

const json = (status: number, body: Body): Response =>
  Response.json(body, { headers: { 'content-type': 'application/json' }, status });

/** Serves gateway assertions and routes vertical calls by "<vertical> <path>". Records every vertical call. */
const installFetch = (routes: Record<string, Route | Reply | Reply[]>): Call[] => {
  const calls: Call[] = [];
  const queue = new Map<string, Reply[]>();
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const { url } = new Request(input);
    const body: Body =
      init?.body === undefined ? {} : BodySchema.parse(JSON.parse(await new Response(init.body).text()));
    if (url === `${SHELL}/shell-super-app-api/auth/api-key/gateway-context`) {
      const { audience } = z.object({ audience: z.string() }).parse(body);
      return json(200, {
        apiBaseUrl: `/shell-super-app-api/module-api/${audience}/build1/${audience}-api`,
        compositionRevision: REVISION,
        expiresAt: expiresAt(),
        token: `token-${audience}`,
      });
    }
    const match = ROUTE_PATTERN.exec(url);
    if (match === null) {
      throw new Error(`unexpected URL ${url}`);
    }
    const { path = '', vertical = '' } = match.groups ?? {};
    const headers = new Headers(init?.headers);
    const call: Call = {
      auth: headers.get('authorization'),
      body,
      idempotencyKey: headers.get('idempotency-key'),
      path,
      vertical,
    };
    calls.push(call);
    const key = `${vertical} ${path}`;
    const route = routes[key];
    if (route === undefined) {
      throw new Error(`no route for ${key}`);
    }
    if (Array.isArray(route)) {
      const pending = queue.get(key) ?? [...route];
      const next = pending.shift();
      queue.set(key, pending);
      if (next === undefined) {
        throw new Error(`route ${key} ran out of replies`);
      }
      return json(next.status ?? 200, next.body);
    }
    const reply = 'body' in route ? route : route(call);
    return json(reply.status ?? 200, reply.body);
  };
  return calls;
};

const applyOf = (calls: readonly Call[], vertical: string) =>
  calls.filter((call) => call.vertical === vertical && call.path.endsWith('/actions/apply-command'));

const SESSION: PrincipalSession = {
  apiKey: 'k',
  kind: 'api_key',
  label: 'test',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  transport: 'http',
  writePolicyOverride: undefined,
};

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
  inputSchema: { type: 'object' },
  kind: 'action',
  moduleId: 'work.tasks',
  proposable: false,
  toolName: 'work_tasks__create_task',
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
  toolName: 'demo_crm__update_client',
};

const createParty: CatalogAction = {
  actionSlug: 'create-party',
  appId: 'party-registry',
  commandTag: undefined,
  id: 'party.registry/action/create-party',
  inputSchema: { type: 'object' },
  kind: 'action',
  moduleId: 'party.registry',
  proposable: false,
  toolName: 'party_registry__create_party',
};

const workModule: CatalogModule = {
  actions: [createTask],
  appId: 'work-tasks',
  displayName: 'Práce',
  moduleId: 'work.tasks',
  probeReadSlug: 'records',
  reads: [workRead],
  supportsAiProposals: false,
  typedTools: true,
};

const crmModule: CatalogModule = {
  actions: [updateClient],
  appId: 'crm',
  displayName: 'CRM',
  moduleId: 'demo.crm',
  probeReadSlug: 'records',
  reads: [],
  supportsAiProposals: true,
  typedTools: true,
};

const partyModule: CatalogModule = {
  actions: [createParty],
  appId: 'party-registry',
  displayName: 'Registr subjektů',
  moduleId: 'party.registry',
  probeReadSlug: undefined,
  reads: [],
  supportsAiProposals: false,
  typedTools: true,
};

const platformModule: CatalogModule = {
  actions: [
    {
      actionSlug: 'apply-command',
      appId: 'approvals',
      commandTag: 'SubmitProposal',
      id: 'platform.approvals/command/SubmitProposal',
      inputSchema: { type: 'object' },
      kind: 'action',
      moduleId: 'platform.approvals',
      proposable: false,
      toolName: 'platform_approvals__submit_proposal',
    },
  ],
  appId: 'approvals',
  displayName: 'Schválení',
  moduleId: 'platform.approvals',
  probeReadSlug: 'records',
  reads: [],
  supportsAiProposals: false,
  typedTools: false,
};

const catalogOf = (modules: readonly CatalogModule[]): Catalog => ({
  compositionRevision: REVISION,
  modules,
  warnings: [],
});

const BASE_CATALOG = catalogOf([workModule, crmModule, partyModule]);

describe('generic read operations', () => {
  it.effect('shapes long arrays and finds reads by id or tool name', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'work-tasks /reads/records': {
          body: { items: Array.from({ length: 120 }, (_, index) => index), revision: 3 },
        },
      });

      const result = yield* Effect.tryPromise(() =>
        runRead(SESSION, BASE_CATALOG, { id: 'work.tasks/read/records', input: { state: 'NEW' } }),
      );

      const read = calls.find((call) => call.path === '/reads/records');
      assert.deepEqual(read?.body, { state: 'NEW' });
      assert.equal(result.id, 'work.tasks/read/records');
      assert.equal(result.legalEntityId, SESSION.legalEntityId);
      const data = result.data as { readonly items: readonly number[] };
      assert.equal(data.items.length, 50);
      assert.deepEqual(result.truncated, [{ offset: 0, path: 'items', returned: 50, total: 120 }]);
      assert.equal(findEntry(BASE_CATALOG, 'work_tasks__read_records')?.id, 'work.tasks/read/records');
    }),
  );
});

describe('generic execute operations', () => {
  it.effect('executes a command directly and reads the revision first', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'work-tasks /reads/records': { body: { revision: 7 } },
        'work-tasks /work-tasks/actions/apply-command': { body: { revision: 8 } },
      });

      const outcome = yield* Effect.tryPromise(() =>
        runExecute(SESSION, BASE_CATALOG, 'direct', {
          id: 'work.tasks/command/CreateTask',
          idempotencyKey: 'k-1',
          input: { title: 'X' },
        }),
      );

      const [apply] = applyOf(calls, 'work-tasks');
      assert.deepEqual(apply?.body, { command: { _tag: 'CreateTask', title: 'X' }, expectedRevision: 7 });
      assert.equal(apply?.idempotencyKey, 'k-1');
      assert.equal(outcome.status, 'executed');
    }),
  );

  it.effect('uses input.expectedRevision without reading the revision', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'work-tasks /work-tasks/actions/apply-command': { body: { revision: 6 } },
      });

      yield* Effect.tryPromise(() =>
        runExecute(SESSION, BASE_CATALOG, 'direct', {
          id: 'work.tasks/command/CreateTask',
          input: { expectedRevision: 5, title: 'X' },
        }),
      );

      assert.equal(calls.some((call) => call.path === '/reads/records'), false);
      const [apply] = applyOf(calls, 'work-tasks');
      assert.equal(apply?.body.expectedRevision, 5);
      assert.equal('expectedRevision' in (apply?.body.command as Record<string, unknown>), false);
    }),
  );

  it.effect('proposes a module change through AiProposeChanges under the approval policy', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'crm /reads/records': { body: { revision: 4 } },
        'crm /crm/actions/apply-command': { body: { status: 'pending' } },
      });

      const outcome = yield* Effect.tryPromise(() =>
        runExecute(SESSION, BASE_CATALOG, 'approval', {
          id: 'demo.crm/command/UpdateClient',
          idempotencyKey: 'run-1',
          input: { id: 'c1', patch: { phone: '1' } },
          reason: 'Telefon ověřen',
        }),
      );

      const [apply] = applyOf(calls, 'crm');
      assert.deepEqual(apply?.body.command, {
        _tag: 'AiProposeChanges',
        changes: [{ operation: { _tag: 'UpdateClient', id: 'c1', patch: { phone: '1' } }, reason: 'Telefon ověřen' }],
        instruction: 'Telefon ověřen',
        runId: 'run-1',
      });
      assert.equal(outcome.status, 'proposed');
      assert.equal(outcome.status === 'proposed' ? outcome.via : undefined, 'module-ai-proposals');
      assert.match(outcome.status === 'proposed' ? outcome.messageCs : '', /\/cs\/sprava\/ke-schvaleni/u);
    }),
  );

  it.effect('rejects a command that cannot be proposed under the approval policy', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({});
      yield* Effect.tryPromise(() =>
        assert.rejects(
          runExecute(SESSION, BASE_CATALOG, 'approval', {
            id: 'work.tasks/command/CreateTask',
            input: { title: 'X' },
          }),
          /jen přes schválení/u,
        ),
      );
      assert.equal(calls.length, 0);
    }),
  );

  it.effect('posts a named action with the raw payload', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'party-registry /party-registry/actions/create-party': { body: { id: 'p1' } },
      });

      yield* Effect.tryPromise(() =>
        runExecute(SESSION, BASE_CATALOG, 'direct', {
          id: 'party.registry/action/create-party',
          input: { name: 'A' },
        }),
      );

      const [call] = calls;
      assert.equal(call?.path, '/party-registry/actions/create-party');
      assert.deepEqual(call?.body, { name: 'A' });
    }),
  );

  it.effect('submits a proposal to the platform approvals module when it is available', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'work-tasks /reads/records': { body: { revision: 7 } },
        'approvals /reads/records': { body: { revision: 2 } },
        'approvals /approvals/actions/apply-command': { body: { revision: 3 } },
      });

      const outcome = yield* Effect.tryPromise(() =>
        runExecute(SESSION, catalogOf([workModule, crmModule, partyModule, platformModule]), 'approval', {
          id: 'work.tasks/command/CreateTask',
          input: { title: 'X' },
        }),
      );

      const [submit] = applyOf(calls, 'approvals');
      assert.equal(submit?.body.command !== undefined, true);
      const command = submit?.body.command as Record<string, unknown>;
      assert.equal(command._tag, 'SubmitProposal');
      assert.equal(command.targetModuleId, 'work.tasks');
      assert.equal(outcome.status === 'proposed' ? outcome.via : undefined, 'platform-approvals');
    }),
  );
});

describe('shapeReadResult', () => {
  it.effect('slices arrays up to depth three and keeps the input unchanged', () =>
    Effect.sync(() => {
      const input = { state: { clients: { items: [1, 2, 3] } } };
      const result = shapeReadResult(input, { limit: 2, offset: 0 });

      assert.deepEqual(result.truncated, [{ offset: 0, path: 'state.clients.items', returned: 2, total: 3 }]);
      assert.deepEqual(result.data, { state: { clients: { items: [1, 2] } } });
      assert.deepEqual(input, { state: { clients: { items: [1, 2, 3] } } });
    }),
  );
});
