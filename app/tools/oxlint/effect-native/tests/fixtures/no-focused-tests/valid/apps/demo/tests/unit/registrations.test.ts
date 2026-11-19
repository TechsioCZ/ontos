import { Effect } from 'effect';
import { describe, it } from 'effect-rstest';

const filters = { only: (value: string) => value };

describe('orders', () => {
  it.effect('reads an order', () => Effect.sync(() => filters.only('open')));
  it.live.skip('reads a live order', () => Effect.void);
});

export const fixture = "it.effect.only('focused', () => Effect.void);";
