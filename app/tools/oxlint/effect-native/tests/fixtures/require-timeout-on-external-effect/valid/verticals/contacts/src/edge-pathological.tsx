// Exotic-but-parseable syntax around bounded bridges: the traversal must survive it and stay silent.
import { Effect } from 'effect';

declare const db: { read: () => Promise<string> };
declare function Injectable(value: unknown): ClassDecorator;
declare const Panel: (props: { children?: unknown }) => unknown;

export enum Kind {
  Read = 'read',
}

@Injectable(Effect.tryPromise(() => db.read()).pipe(Effect.timeout('1 second')))
export class Decorated {
  static readonly boot = Effect.promise(async () => await db.read()).pipe(Effect.retry({ times: 2 }));
  #hidden = Effect.tryPromise(() => db.read()).pipe(Effect.timeout('1 second'));
  read() {
    return this.#hidden;
  }
}

export async function* rows() {
  yield await Effect.runPromise(
    Effect.tryPromise(() => db.read()).pipe(Effect.timeoutOrElse({ duration: '1 second', onTimeout: () => Effect.succeed('') })),
  );
}

export const Rendered = <T,>(value: T) => (
  <Panel children={`${String(value)}${String(Effect.tryPromise(() => db.read()).pipe(Effect.timeout('1 second')))}`} />
);
