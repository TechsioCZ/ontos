// @rstest-environment happy-dom
import { AgentActivityResponseSchema, AgentQueueResponseSchema } from '@app/shared-contracts/agent-proposals';
import type { AgentActivityRequest, AgentQueueRequest } from '@app/shared-contracts/agent-proposals';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { browserNetwork, networkIdle, pinTestDocument, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../../shared/browser-api.ts';
import {
  DEFAULT_ACTIVITY_REQUEST,
  DEFAULT_QUEUE_REQUEST,
  agentActivityData,
  agentQueueData,
} from '../../../src/routes/agent-platform/platform-page-data.ts';

const platformEndpoints = ShellAuthenticationApi.groups.agentPlatform.endpoints;
const PlatformApi = HttpApi.make('platformLiveChangeTest')
  .add(HttpApiGroup.make('agentPlatform').add(platformEndpoints.agentActivity).add(platformEndpoints.agentQueue))
  .prefix(shellAuthenticationApiContract.apiPrefix);
const emptyActivity = Schema.decodeUnknownSync(AgentActivityResponseSchema)({
  agents: [],
  entries: [],
  modules: [],
});
const emptyQueue = Schema.decodeUnknownSync(AgentQueueResponseSchema)({
  batches: [],
  company: { legalEntityId: '20000000-0000-4000-8000-000000000001', legalName: 'Alpha company' },
  pendingCount: 0,
  unavailableModules: [],
});

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  window.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  agentActivityData.invalidate();
  agentQueueData.invalidate();
});

// Agents act, and approved proposals execute, in every module; such a change names that module's app, not 'shell'.
it.live('an agent change in another module reloads the mounted activity and approval queue', () =>
  Effect.gen(function* moduleChange() {
    yield* pinTestDocument;
    const activityReads: AgentActivityRequest[] = [];
    const queueReads: AgentQueueRequest[] = [];
    const activityReloaded = yield* Deferred.make<boolean>();
    const queueReloaded = yield* Deferred.make<boolean>();
    const network = browserNetwork(
      serveApi(
        PlatformApi,
        HttpApiBuilder.group(PlatformApi, 'agentPlatform', (group) =>
          group
            .handle('agentActivity', ({ payload }) =>
              Effect.gen(function* activity() {
                activityReads.push(payload);
                if (activityReads.length === 2) {
                  yield* Deferred.succeed(activityReloaded, true);
                }
                return emptyActivity;
              }),
            )
            .handle('agentQueue', ({ payload }) =>
              Effect.gen(function* queue() {
                queueReads.push(payload);
                if (queueReads.length === 2) {
                  yield* Deferred.succeed(queueReloaded, true);
                }
                return emptyQueue;
              }),
            ),
        ),
      ),
    );
    yield* Effect.gen(function* mountedPlatform() {
      yield* agentActivityData.preload(DEFAULT_ACTIVITY_REQUEST);
      yield* agentQueueData.preload(DEFAULT_QUEUE_REQUEST);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          agentActivityData.subscribe(() => {
            agentActivityData.snapshot(DEFAULT_ACTIVITY_REQUEST);
          }, DEFAULT_ACTIVITY_REQUEST),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          agentQueueData.subscribe(() => {
            agentQueueData.snapshot(DEFAULT_QUEUE_REQUEST);
          }, DEFAULT_QUEUE_REQUEST),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      yield* networkIdle;
      expect(activityReads).toHaveLength(1);
      expect(queueReads).toHaveLength(1);
      dispatchChange(['merchandise']);
      yield* Deferred.await(activityReloaded);
      yield* Deferred.await(queueReloaded);
      yield* networkIdle;
      expect(activityReads).toHaveLength(2);
      expect(queueReads).toHaveLength(2);
      yield* agentActivityData.preload(DEFAULT_ACTIVITY_REQUEST);
      yield* agentQueueData.preload(DEFAULT_QUEUE_REQUEST);
    }).pipe(Effect.scoped, Effect.provide(network));
  }),
);
