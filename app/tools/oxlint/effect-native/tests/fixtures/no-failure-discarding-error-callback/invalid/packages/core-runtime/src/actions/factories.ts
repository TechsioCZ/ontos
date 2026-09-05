// expect-count: 4
import { Effect as E } from 'effect';

class CollectorInputError {}
class PersistenceError {}

const invalidCollectorInput = () => new CollectorInputError();
function unavailable(_reason: unknown) {
  return new PersistenceError();
}

declare const decode: E.Effect<string, Error>;
declare const write: () => Promise<void>;

export const decoded = decode.pipe(E.mapError(invalidCollectorInput));

export const written = E.tryPromise({ try: () => write(), catch: unavailable });

export const caught = decode.pipe(E.catch(invalidCollectorInput));

export const orElse = decode.pipe(E.orElseFail(() => new PersistenceError()));
