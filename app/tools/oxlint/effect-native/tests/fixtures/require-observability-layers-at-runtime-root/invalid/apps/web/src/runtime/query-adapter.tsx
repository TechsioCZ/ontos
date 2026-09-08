// expect-count: 3
// Declared browser runtime root (rootFiles glob), no runtime-constructing call in the file itself.
import { Effect, Layer } from 'effect';

export const browserLayer = Layer.mergeAll(Layer.succeed(Effect.void as never, 1 as never));

export const Boundary = () => <div>ontos</div>;
