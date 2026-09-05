// Crash probe: exotic syntax around the shapes this rule matches, with no untagged service seam.
import { Context, Effect } from 'effect';

declare global {
  interface Window {
    readonly __ontos?: string;
  }
}

declare module 'node:test' {
  interface TestContext {
    readonly ontos?: string;
  }
}

const track = (): MethodDecorator => () => undefined;

export class ContactsWidget {
  static readonly key = `contacts-${'widget'}` as const;
  #cache = new WeakMap<object, string>();

  @track()
  async *stream(): AsyncGenerator<string> {
    yield 'a';
  }

  get cache(): WeakMap<object, string> {
    return this.#cache;
  }
}

export interface ContactsSnapshotRow {
  readonly id: string;
}

export const nested: Effect.Effect<
  ReadonlyArray<ReadonlyMap<string, ReadonlySet<Array<Record<string, string>>>>>
> = Effect.succeed([]);

export const marker = Context.GenericTag<{ readonly id: string }>('@app/verticals/contacts/Marker');
