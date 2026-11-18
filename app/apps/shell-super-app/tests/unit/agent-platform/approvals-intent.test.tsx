// @rstest-environment happy-dom
// The approvals panel over its real platform client, queue page data and Shell router, served in process.
import { acted, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  AgentDecideResponseSchema,
  AgentLegalEntityIdSchema,
  AgentQueueBatchSchema,
  AgentQueueResponseSchema,
  AgentRevertResponseSchema,
} from '@app/shared-contracts/agent-proposals';
import type { AgentQueueResponse } from '@app/shared-contracts/agent-proposals';
import { networkIdle, streamingBrowserNetwork } from '@app/shared-contracts/testing/http-double';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Deferred, Effect, Exit, Layer, Predicate, Schema, Stream } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import { ApprovalsPanel } from '../../../src/routes/agent-platform/approvals-panel.tsx';
import { agentQueueData } from '../../../src/routes/agent-platform/platform-page-data.ts';
import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import { shellLocaleCopy } from '../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../support/shell-router.tsx';

const batch = Schema.decodeUnknownSync(AgentQueueBatchSchema)({
  agentLabel: 'Agent',
  agentPrincipalId: 'principal',
  batchId: 'batch',
  canRevertAll: true,
  createdAt: '2026-10-25T10:00:00.000Z',
  instruction: 'Review changes',
  items: [
    {
      appId: 'work-tasks',
      canDecide: true,
      diff: [],
      key: 'core:item',
      moduleKey: 'work-tasks',
      moduleLabel: 'Tasks',
      proposedAt: '2026-10-25T10:00:00.000Z',
      reason: 'Requested',
      risk: 'low',
      status: 'pending',
      summary: 'Task',
      targetLabel: 'Target',
    },
  ],
  key: 'core:batch',
  moduleLabels: ['Tasks'],
  source: 'core',
});
const company = { legalEntityId: AgentLegalEntityIdSchema.make('company'), legalName: 'Company' };
const pendingQueue = AgentQueueResponseSchema.make({
  batches: [batch],
  company,
  pendingCount: 1,
  unavailableModules: [],
});
const emptyQueue = AgentQueueResponseSchema.make({ batches: [], company, pendingCount: 0, unavailableModules: [] });

/** One mutation as the platform endpoint received it from the window. */
interface Mutation {
  readonly body: string;
  readonly credentials: unknown;
  readonly idempotencyKey: string | undefined;
  readonly path: string;
}

let queue: AgentQueueResponse = pendingQueue;
let queueReads = 0;
let mutations: Mutation[] = [];
/** The platform's answers to the next mutations, in order. */
let answers: Effect.Effect<HttpServerResponse.HttpServerResponse>[] = [];

const problem = (detail: string, status: number) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ detail }, { status }));
const decided = Schema.decodeUnknownSync(AgentDecideResponseSchema)({
  results: [{ itemKey: 'core:item', outcome: 'applied' }],
});
const encodedDecision = Schema.encodeSync(AgentDecideResponseSchema)(decided);
const applied = () => Effect.succeed(HttpServerResponse.jsonUnsafe(encodedDecision));
const denied = () => problem('Denied', 403);
/** The answer whose head arrives and whose body then breaks off, as a dropped connection loses it. */
const lost = () =>
  Effect.succeed(
    HttpServerResponse.stream(Stream.fail(new Error('connection lost')), { contentType: 'application/json' }),
  );

const mutation = (path: string) =>
  HttpRouter.add(
    'POST',
    `/shell-super-app-api/agent-platform${path}`,
    Effect.gen(function* receiveMutation() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      mutations.push({
        body: yield* request.text,
        credentials: Predicate.hasProperty(request.source, 'credentials') ? request.source.credentials : undefined,
        idempotencyKey: request.headers['idempotency-key'],
        path,
      });
      const [next, ...rest] = answers;
      answers = rest;
      return yield* next ?? Effect.die(`No answer scripted for ${path}`);
    }).pipe(Effect.orDie),
  );

const platform = streamingBrowserNetwork(
  Layer.mergeAll(
    HttpRouter.add(
      'POST',
      '/shell-super-app-api/agent-platform/queue',
      Effect.suspend(() => {
        queueReads += 1;
        return Effect.succeed(HttpServerResponse.jsonUnsafe(Schema.encodeSync(AgentQueueResponseSchema)(queue)));
      }),
    ),
    mutation('/decide'),
    mutation('/revert'),
  ),
);

beforeEach(() => {
  queue = pendingQueue;
  queueReads = 0;
  mutations = [];
  answers = [];
  // Each case reads the queue afresh, as a newly opened document does.
  agentQueueData.invalidate();
});
afterEach(cleanup);

/** Opens the approvals and waits until the queue read settled; returns the reads it took. */
const openApprovals = Effect.gen(function* openApprovals() {
  const router = makeShellRouter({ page: { component: ApprovalsPanel, path: 'approvals' }, url: '/cs/approvals' });
  const view = yield* renderShellRoute(router, shellLocaleCopy('cs'));
  yield* waitUntil(() => screen.queryByRole('button', { name: 'Schválit dávku (1)' }) !== null);
  yield* networkIdle;
  return { reads: queueReads, view };
});

const click = (name: string) =>
  acted(() => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
const failedDecision = 'Rozhodnutí se nepodařilo uložit. Zkuste to prosím znovu.';
const retry = 'Zopakovat původní požadavek';

it.live('retains the original decision and key after a lost response, note edit and queue removal', () =>
  Effect.gen(function* retryOriginalDecision() {
    answers = [lost()];
    const { reads } = yield* openApprovals;
    yield* acted(() => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Original note' } });
    });
    yield* click('Schválit dávku (1)');
    yield* waitUntil(() => screen.queryByText(failedDecision) !== null);
    yield* networkIdle;
    expect(queueReads).toBe(reads);
    yield* acted(() => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed after failure' } });
    });
    // The queue no longer lists the batch, as after another reviewer's refresh.
    queue = emptyQueue;
    yield* Effect.promise(() => browserRuntime.runPromise(agentQueueData.refresh({ pendingOnly: true })));
    yield* waitUntil(() => screen.queryByRole('button', { name: 'Schválit dávku (1)' }) === null);
    const beforeRetry = queueReads;
    answers = [applied()];
    yield* click(retry);
    yield* waitUntil(() => queueReads === beforeRetry + 1);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.idempotencyKey).toBeTruthy();
    expect(mutations[0]?.credentials).toBe('same-origin');
    expect(mutations[1]?.credentials).toBe('same-origin');
    expect(mutations[1]?.idempotencyKey).toBe(mutations[0]?.idempotencyKey);
    expect(mutations[1]?.body).toBe(mutations[0]?.body);
    expect(mutations[1]?.body).toBe(
      '{"batchKey":"core:batch","decision":"approve","itemKeys":["core:item"],"note":"Original note"}',
    );
    expect(screen.queryByRole('button', { name: retry })).toBeNull();
  }).pipe(Effect.provide(platform)),
);

it.live('creates a new key for an intentionally changed decision and clears it after a terminal rejection', () =>
  Effect.gen(function* changedDecision() {
    answers = [lost(), denied(), denied()];
    const { reads } = yield* openApprovals;
    yield* click('Schválit dávku (1)');
    yield* waitUntil(() => screen.queryByText(failedDecision) !== null);
    yield* click('Zamítnout dávku');
    yield* waitUntil(() => queueReads === reads + 1);
    expect(mutations[1]?.idempotencyKey).not.toBe(mutations[0]?.idempotencyKey);
    expect(screen.queryByRole('button', { name: retry })).toBeNull();
    yield* waitUntil(
      () => screen.queryByRole('button', { name: 'Zamítnout dávku' })?.hasAttribute('disabled') === false,
    );
    yield* click('Zamítnout dávku');
    yield* waitUntil(() => queueReads === reads + 2);
    expect(mutations).toHaveLength(3);
    expect(mutations[2]?.idempotencyKey).not.toBe(mutations[1]?.idempotencyKey);
  }).pipe(Effect.provide(platform)),
);

it.live('keeps a mutation single-flight through body consumption and finalizes it before the next action', () =>
  Effect.gen(function* bodySingleFlight() {
    const answered = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    let bodyInterrupted = false;
    const bytes = new TextEncoder().encode(JSON.stringify(encodedDecision));
    // The head is answered at once; the body arrives only when the case releases it.
    answers = [
      Deferred.succeed(answered, true).pipe(
        Effect.as(
          HttpServerResponse.stream(
            Stream.fromEffect(Deferred.await(release).pipe(Effect.as(bytes))).pipe(
              Stream.onExit((exit) =>
                Effect.sync(() => {
                  bodyInterrupted = Exit.isFailure(exit);
                }),
              ),
            ),
            { contentType: 'application/json' },
          ),
        ),
      ),
      denied(),
    ];
    const { reads } = yield* openApprovals;
    const approve = screen.getByRole('button', { name: 'Schválit dávku (1)' });
    yield* acted(() => {
      fireEvent.click(approve);
      fireEvent.click(approve);
    });
    yield* Deferred.await(answered);
    yield* networkIdle;
    expect(mutations).toHaveLength(1);
    expect(approve.hasAttribute('disabled')).toBe(true);
    expect(queueReads).toBe(reads);
    expect(bodyInterrupted).toBe(false);
    yield* Deferred.succeed(release, true);
    yield* waitUntil(() => queueReads === reads + 1);
    expect(bodyInterrupted).toBe(false);
    yield* waitUntil(() => !approve.hasAttribute('disabled'));
    yield* acted(() => {
      fireEvent.click(approve);
    });
    yield* waitUntil(() => queueReads === reads + 2);
    expect(mutations).toHaveLength(2);
    expect(mutations[1]?.idempotencyKey).not.toBe(mutations[0]?.idempotencyKey);
  }).pipe(Effect.provide(platform)),
);

it.live('retains a revert payload and key through an uncertain server error', () =>
  Effect.gen(function* retryOriginalRevert() {
    answers = [
      problem('Unavailable', 503),
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          Schema.encodeSync(AgentRevertResponseSchema)(
            Schema.decodeUnknownSync(AgentRevertResponseSchema)({ message: 'Restored', outcome: 'reverted' }),
          ),
        ),
      ),
    ];
    yield* openApprovals;
    yield* click('Vrátit vše');
    yield* click('Potvrdit vrácení celé dávky');
    yield* waitUntil(() => screen.queryByText('Dávku se nepodařilo vrátit. Zkuste to prosím znovu.') !== null);
    yield* click(retry);
    yield* waitUntil(() => screen.queryByText('Restored') !== null);
    expect(mutations[1]?.path).toBe('/revert');
    expect(mutations[1]?.idempotencyKey).toBe(mutations[0]?.idempotencyKey);
    expect(mutations[1]?.body).toBe(mutations[0]?.body);
  }).pipe(Effect.provide(platform)),
);
