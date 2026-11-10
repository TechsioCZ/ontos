import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';
import {
  DEFAULT_ACTIVITY_REQUEST,
  DEFAULT_QUEUE_REQUEST,
  agentActivityData,
  agentQueueData,
} from '../../../src/routes/agent-platform/platform-page-data.ts';

const mocks = rstest.hoisted(() => ({ activity: rstest.fn(), queue: rstest.fn() }));
rstest.mock('../../../src/routes/agent-platform/agent-platform-client.ts', () => ({
  loadAgentActivity: mocks.activity,
  loadAgentQueue: mocks.queue,
}));

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  window.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  rstest.resetAllMocks();
  agentActivityData.invalidate();
  agentQueueData.invalidate();
  mocks.activity.mockResolvedValue({ status: 'ok', value: { items: [] } });
  mocks.queue.mockResolvedValue({ status: 'ok', value: { items: [] } });
});

// Agents act, and approved proposals execute, in every module; such a change names that module's app, not 'shell'.
it.live('an agent change in another module reloads the mounted activity and approval queue', () =>
  Effect.gen(function* moduleChange() {
    yield* agentActivityData.preload(DEFAULT_ACTIVITY_REQUEST);
    yield* agentQueueData.preload(DEFAULT_QUEUE_REQUEST);
    const unsubscribeActivity = agentActivityData.subscribe(() => {
      agentActivityData.snapshot(DEFAULT_ACTIVITY_REQUEST);
    }, DEFAULT_ACTIVITY_REQUEST);
    const unsubscribeQueue = agentQueueData.subscribe(() => {
      agentQueueData.snapshot(DEFAULT_QUEUE_REQUEST);
    }, DEFAULT_QUEUE_REQUEST);
    expect(mocks.activity).toHaveBeenCalledTimes(1);
    expect(mocks.queue).toHaveBeenCalledTimes(1);
    dispatchChange(['merchandise']);
    yield* Effect.sleep('10 millis');
    expect(mocks.activity).toHaveBeenCalledTimes(2);
    expect(mocks.queue).toHaveBeenCalledTimes(2);
    unsubscribeActivity();
    unsubscribeQueue();
  }),
);
