// This re-export merely forwards Effect; composing the program starts no runtime.
import { Effect } from 'effect';

export const program = Effect.succeed(1);

export { Effect };
