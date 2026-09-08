// expect-count: 5
// `.mts` plus the TypeScript-only constructs a syntactic walker can choke on.
import { Effect } from 'effect';

declare const db: { read: () => Promise<string> };

export enum Kind {
  Read = 'read',
}

declare module 'node:fs' {
  interface Stats {
    ontosMarker?: string;
  }
}

export namespace Legacy {
  export const marker = 1;
}

export abstract class Base {
  abstract read(): unknown;
  protected readonly bridge = Effect.tryPromise(() => db.read());
}

export function withDefault(effect = Effect.tryPromise(() => db.read())) {
  return effect;
}

export async function drain(chunks: AsyncIterable<string>) {
  outer: for await (const chunk of chunks) {
    void chunk;
    void Effect.promise(async () => await db.read());
    break outer;
  }
  try {
    void Effect.tryPromise(() => db.read());
  } catch {
    /* noop */
  }
  switch (Kind.Read as string) {
    case 'read': {
      void Effect.tryPromise(() => db.read());
      break;
    }
    default:
      break;
  }
}
