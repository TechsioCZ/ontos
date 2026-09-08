// expect-count: 2
import * as Effect from 'effect';

import { CacheLive, SessionLive } from './session.ts';

export const SessionServiceLive = SessionLive.pipe(
  Effect.Layer.provide(CacheLive),
  Effect.Layer.provideMerge(CacheLive),
);
