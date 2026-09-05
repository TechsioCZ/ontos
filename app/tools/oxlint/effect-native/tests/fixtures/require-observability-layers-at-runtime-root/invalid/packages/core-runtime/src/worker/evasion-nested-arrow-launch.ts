// expect-count: 3
// Evasion: `Layer.launch` buried in a nested arrow body inside an object literal.
import { Layer } from 'effect';

declare const workerLayer: Layer.Layer<never>;

export const handlers = {
  start: () => () => Layer.launch(workerLayer),
};
