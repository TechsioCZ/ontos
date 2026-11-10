import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';

import { tagCatalogData } from '../../src/components/tag-controls.tsx';

const { listTagsMock } = rstest.hoisted(() => ({ listTagsMock: rstest.fn() }));

// `listTags` is an Effect value in the real client, so the mock re-runs the counted fake on every read.
rstest.mock('../../src/api/records-consumer.ts', () => ({
  listTags: Effect.suspend(() => listTagsMock()),
  recordsOfKind: rstest.fn(),
}));

const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
};

beforeAll(() => {
  for (const [name, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, name, value);
  }
  Reflect.set(globalThis, 'document', {});
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'document');
  for (const name of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, name);
  }
});

// The tag catalog is tagging data; a change committed by another module must not re-read it.
it.live('the tag catalog reloads on tagging changes only', () =>
  Effect.gen(function* scopedTagCatalog() {
    listTagsMock.mockReset();
    listTagsMock.mockReturnValue(Effect.succeed([]));
    yield* tagCatalogData.preload('all');
    expect(listTagsMock).toHaveBeenCalledTimes(1);
    const unsubscribe = tagCatalogData.subscribe(() => {
      tagCatalogData.snapshot('all');
    });
    events.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['party-registry'] } }));
    yield* Effect.sleep('10 millis');
    expect(listTagsMock).toHaveBeenCalledTimes(1);
    events.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['tagging'] } }));
    yield* Effect.sleep('10 millis');
    expect(listTagsMock).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
