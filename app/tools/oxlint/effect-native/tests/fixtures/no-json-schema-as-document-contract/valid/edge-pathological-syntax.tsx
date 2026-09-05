// Crash probe: decorators, class accessors/getters/static blocks, async generators, spreads,
// circular module aliases, computed template-literal keys, `satisfies` — none of it is Effect's
// `Schema.Json`, so nothing may be reported and nothing may throw.
import { Schema } from 'effect';

const decorate = (_target: unknown, _context: unknown) => undefined;

const alpha = beta;
const beta = alpha;
const selfish = selfish;

const Json = { kind: 'json' } as const;
export const documentKinds = { [`manifest`]: Json, ...Json } satisfies Record<string, unknown>;

export const withInjectedSchema = (Schema: { readonly Json: string }) => Schema.Json;

@decorate
export class OverlayReader {
  static #cache = new WeakMap<object, unknown>();
  static {
    void OverlayReader.#cache;
  }

  accessor label: string = 'overlay';

  get contract(): typeof Json {
    return Json;
  }

  async *stream(): AsyncGenerator<unknown> {
    yield* [alpha, beta, selfish];
  }
}

export const Ownership = Schema.Struct({ owner: Schema.String });

export const Panel = () => <div title={`${String(documentKinds)}`}>{Schema.String.toString()}</div>;
