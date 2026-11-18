// expect-count: 4
import { Effect } from 'effect';
import { describe, it as register } from 'effect-rstest';

describe.only('orders', () => {
  register.effect.only('reads an order', () => Effect.void);
  register.live.only('reads a live order', () => Effect.void);
  register.only('plain test', () => {});
});
