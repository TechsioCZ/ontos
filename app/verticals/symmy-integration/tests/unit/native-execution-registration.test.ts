import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { outboxWorkers } from '../../src/workers/index.ts';
import {
  makeNativeExecutionRegistration,
  makeNativeExecutionSnapshot,
} from '../support/symmy-job-execution-native.fixture.ts';

it.effect('builds the native execution composition with every public Symmy Read bound to its runtime', () =>
  Effect.gen(function* nativeExecutionComposition() {
    const owner = makeNativeExecutionRegistration(outboxWorkers);
    const snapshot = yield* makeNativeExecutionSnapshot(owner);
    expect(snapshot.composition.modules.map(({ moduleId }) => moduleId)).toContain(owner.registration.moduleId);
  }),
);
