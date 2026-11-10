import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { allRecordsInput, pipelineRecords } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-records.ts';

const mocks = rstest.hoisted(() => ({ records: rstest.fn() }));
rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: mocks.records }));

const events = new EventTarget();
const globals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [key, value] of Object.entries(globals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(globals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

const input = allRecordsInput('company-a');

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  events.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  rstest.resetAllMocks();
  pipelineRecords.invalidate();
  mocks.records.mockReturnValue(Effect.succeed({ items: [], revision: 7 }));
});

it.live('live changes of apps the pipeline records do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pipelineRecords.preload(input);
    const unsubscribe = pipelineRecords.subscribe(() => {
      pipelineRecords.snapshot(input);
    }, input);
    expect(mocks.records).toHaveBeenCalledTimes(1);
    dispatchChange(['merchandise']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(1);
    unsubscribe();
  }),
);

it.live('a live change of sales-pipeline reloads the mounted pipeline records', () =>
  Effect.gen(function* ownChange() {
    yield* pipelineRecords.preload(input);
    const unsubscribe = pipelineRecords.subscribe(() => {
      pipelineRecords.snapshot(input);
    }, input);
    dispatchChange(['sales-pipeline']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
