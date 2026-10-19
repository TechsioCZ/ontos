// Argument mapping for the sales-agent tools, against a mocked fetch. No shell is contacted.
// Run: pnpm --filter @ontos/agent-mcp test
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe } from '@rstest/core';
import { it } from 'effect-rstest';
import { Effect, Predicate } from 'effect';
import { z } from 'zod';

const SHELL = 'http://shell.test';
const REVISION = 'a'.repeat(64);
process.env.ONTOS_AGENT_API_KEY = 'test-agent-key';
process.env.ONTOS_SHELL_URL = SHELL;
process.env.ONTOS_COMPOSITION_REVISION = REVISION;

const { createTask } = await import('../src/tools/work.ts');
const { createOpportunity } = await import('../src/tools/sales.ts');
const { assignTags } = await import('../src/tools/tagging.ts');
const { getMetrics } = await import('../src/tools/metrics.ts');
const { describeError, runTool } = await import('../src/tools/shared.ts');

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
    const call: Call = { auth: headers.get('authorization'), body, path, vertical };
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

const taskWire = {
  collectionRef: {},
  contextRefs: [],
  createdAt: '2026-10-05T08:00:00.000Z',
  dueDate: '2026-10-20',
  priority: 'HIGH',
  ref: {
    moduleId: 'siampark.work',
    resourceId: 'task-1',
    resourceType: 'siampark.work.task',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  state: 'NEW',
  title: 'Zavolat klientovi',
  updatedAt: '2026-10-05T08:00:00.000Z',
};

const opportunityWire = {
  amountMinor: 246_912,
  createdAt: '2026-10-05T08:00:00.000Z',
  currency: 'CZK',
  expectedCloseDate: '2026-11-30',
  id: '11111111-1111-4111-8111-111111111111',
  lines: [],
  partyId: '22222222-2222-4222-8222-222222222222',
  probability: 50,
  stage: 'LEAD',
  stageHistory: [],
  title: 'Servery',
  updatedAt: '2026-10-05T08:00:00.000Z',
};

const tagVip = () => ({
  color: 'blue',
  counts: { customer: 0 },
  createdAt: '2026-10-01T00:00:00.000Z',
  id: 'tag-vip',
  name: 'VIP',
  subjectKinds: ['customer'],
  updatedAt: '2026-10-01T00:00:00.000Z',
});

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('write tools map arguments onto apply-command', () => {
  it.effect('create_task sends CreateTask with the revision read first', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'siampark-work /reads/records': {
          body: {
            canWrite: true,
            indicators: { open: 0, openByAssignee: [], overdue: 0 },
            items: [],
            referenceDate: '2026-10-05',
            revision: 7,
          },
        },
        'siampark-work /siampark-work/actions/apply-command': { body: { revision: 8, task: taskWire } },
      });

      const result = yield* Effect.tryPromise(() =>
        createTask({
          dueDate: '2026-10-20',
          partyId: 'p-1',
          priority: 'HIGH',
          title: 'Zavolat klientovi',
        }),
      );

      const [apply] = applyOf(calls, 'siampark-work');
      assert.ok(apply !== undefined);
      assert.deepEqual(apply.body, {
        command: {
          _tag: 'CreateTask',
          dueDate: '2026-10-20',
          partyId: 'p-1',
          priority: 'HIGH',
          title: 'Zavolat klientovi',
        },
        expectedRevision: 7,
      });
      assert.equal(apply.auth, 'Bearer token-siampark-work');
      assert.deepEqual(result, {
        revision: 8,
        task: {
          assigneeEmployeeId: null,
          description: null,
          dueDate: '2026-10-20',
          id: 'task-1',
          opportunityId: null,
          partyId: null,
          priority: 'HIGH',
          state: 'NEW',
          stateCs: 'nový',
          title: 'Zavolat klientovi',
        },
      });
    }),
  );

  it.effect('create_opportunity converts CZK unit prices to minor units and omits the owner when absent', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'sales-pipeline /reads/records': {
          body: { actorPrincipalRef: {}, canWrite: true, indicators: {}, items: [], revision: 3 },
        },
        'sales-pipeline /sales-pipeline/actions/apply-command': {
          body: { opportunities: [opportunityWire], revision: 4 },
        },
      });

      yield* Effect.tryPromise(() =>
        createOpportunity({
          expectedCloseDate: '2026-11-30',
          lines: [{ productName: 'Server', quantity: 2, unitPriceCzk: 1234.56, vatRate: 21 }],
          partyId: '22222222-2222-4222-8222-222222222222',
          probability: 50,
          title: 'Servery',
        }),
      );

      const [apply] = applyOf(calls, 'sales-pipeline');
      assert.ok(apply !== undefined);
      assert.equal(apply.body.expectedRevision, 3);
      const command = BodySchema.parse(apply.body.command);
      assert.equal('ownerEmployeeId' in command, false);
      assert.deepEqual(command.lines, [{ productName: 'Server', quantity: 2, unitPriceMinor: 123_456, vatRate: 21 }]);
      assert.ok(Predicate.isTagged(command, 'CreateOpportunity'));
    }),
  );

  it.effect('assign_tags resolves the tag name case-insensitively and sends subject objects', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'tagging /reads/records': {
          body: {
            assignments: [],
            canWrite: true,
            indicators: { assignmentCount: 0, tagCount: 1 },
            revision: 11,
            tags: [
              {
                color: 'blue',
                counts: { customer: 0 },
                createdAt: '2026-10-01T00:00:00.000Z',
                id: 'tag-vip',
                name: 'VIP',
                subjectKinds: ['customer'],
                updatedAt: '2026-10-01T00:00:00.000Z',
              },
            ],
          },
        },
        'tagging /tagging/actions/apply-command': {
          body: { affectedAssignments: 2, revision: 12, tagId: 'tag-vip' },
        },
      });

      const result = yield* Effect.tryPromise(() =>
        assignTags({ kind: 'customer', subjectIds: ['p-1', 'p-2'], tagName: ' vip ' }),
      );

      const [apply] = applyOf(calls, 'tagging');
      assert.ok(apply !== undefined);
      assert.deepEqual(apply.body, {
        command: {
          _tag: 'AssignTag',
          subjects: [
            { id: 'p-1', kind: 'customer' },
            { id: 'p-2', kind: 'customer' },
          ],
          tagId: 'tag-vip',
        },
        expectedRevision: 11,
      });
      assert.deepEqual(result, {
        affectedAssignments: 2,
        kind: 'customer',
        requested: 2,
        revision: 12,
        tag: 'VIP',
        tagId: 'tag-vip',
      });
    }),
  );

  it.effect('retries once with a fresh revision after a revision conflict', () =>
    Effect.gen(function* testProgram() {
      const calls = installFetch({
        'tagging /reads/records': [
          {
            body: {
              assignments: [],
              canWrite: true,
              indicators: { assignmentCount: 0, tagCount: 1 },
              revision: 11,
              tags: [tagVip()],
            },
          },
          {
            body: {
              assignments: [],
              canWrite: true,
              indicators: { assignmentCount: 0, tagCount: 1 },
              revision: 12,
              tags: [tagVip()],
            },
          },
        ],
        'tagging /tagging/actions/apply-command': [
          {
            body: {
              code: 'tagging_revision_conflict',
              detail: 'Revize se změnila.',
              status: 409,
              title: 'Conflict',
              type: 'x',
            },
            status: 409,
          },
          { body: { affectedAssignments: 1, revision: 13, tagId: 'tag-vip' } },
        ],
      });

      const result = yield* Effect.tryPromise(() =>
        assignTags({ kind: 'customer', subjectIds: ['p-1'], tagId: 'tag-vip' }),
      );

      const applies = applyOf(calls, 'tagging');
      assert.deepEqual(
        applies.map((call) => call.body.expectedRevision),
        [11, 12],
      );
      assert.equal(result.revision, 13);
    }),
  );

  it.effect('reports a 403 as "Agent nemá oprávnění" with the status and problem code', () =>
    Effect.gen(function* testProgram() {
      installFetch({
        'tagging /reads/records': {
          body: {
            assignments: [],
            canWrite: true,
            indicators: { assignmentCount: 0, tagCount: 1 },
            revision: 1,
            tags: [tagVip()],
          },
        },
        'tagging /tagging/actions/apply-command': {
          body: {
            code: 'action_permission_denied',
            detail: 'Agent nemá právo přiřazovat štítky.',
            status: 403,
            title: 'Forbidden',
            type: 'x',
          },
          status: 403,
        },
      });

      const result = yield* Effect.tryPromise(() =>
        runTool(() => assignTags({ kind: 'customer', subjectIds: ['p-1'], tagId: 'tag-vip' })),
      );

      assert.equal(result.isError, true);
      const text = result.content[0]?.text ?? '';
      assert.equal(
        text,
        'Agent nemá oprávnění: Agent nemá právo přiřazovat štítky. (HTTP 403, kód action_permission_denied)',
      );
      assert.equal(describeError(new Error('plain')), 'plain');
    }),
  );
});

describe('get_metrics', () => {
  it.effect('converts CZK engine output from minor units and keeps counts as they are', () =>
    Effect.gen(function* testProgram() {
      installFetch({
        'merchandise /reads/records': {
          body: { indicators: {}, movements: [], orders: [], products: [], revision: 1 },
        },
        'party-registry /reads/customer-list': { body: { items: [] } },
        'sales-pipeline /reads/records': { body: { indicators: {}, items: [], revision: 1 } },
        'siampark-billing-finance /reads/records': {
          body: {
            canWrite: true,
            indicators: {},
            referenceDate: '2026-10-05',
            revision: 1,
            state: {
              invoices: [
                {
                  businessState: 'CONFIRMED',
                  counterpartyRef: { resourceId: 'c-1' },
                  direction: 'OUTGOING',
                  documentNumber: 'FV-2026-0001',
                  dueDate: '2026-10-20',
                  issueDate: '2026-10-01',
                  paidMinor: 0,
                  paymentState: 'UNPAID',
                  totalMinor: 100_050,
                },
              ],
            },
          },
        },
        'siampark-work /reads/records': {
          body: { indicators: {}, items: [], referenceDate: '2026-10-05', revision: 1 },
        },
        'tagging /reads/records': { body: { assignments: [], revision: 1, tags: [] } },
        'workforce /reads/records': { body: { items: [] } },
      });

      const result = yield* Effect.tryPromise(() =>
        getMetrics({
          from: '2026-10-01',
          groupBy: 'month',
          metric: 'revenue_invoiced',
          to: '2026-10-31',
        }),
      );

      assert.equal(result.unit, 'CZK');
      assert.equal(result.total, 1000.5);
      assert.equal(result.referenceDate, '2026-10-05');
    }),
  );

  it.effect('rejects a grouping the metric does not support', () =>
    Effect.gen(function* testProgram() {
      yield* Effect.tryPromise(() =>
        assert.rejects(
          getMetrics({ from: '2026-10-01', groupBy: 'product', metric: 'tasks_open', to: '2026-10-31' }),
          /nepodporuje seskupení product/u,
        ),
      );
    }),
  );
});
