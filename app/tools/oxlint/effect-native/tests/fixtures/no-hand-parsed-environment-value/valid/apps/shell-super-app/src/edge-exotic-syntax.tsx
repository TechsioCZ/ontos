// Parser robustness: decorators, class static blocks, `accessor`, `#private` fields, TSX generic
// arrows, async generators, optional catch binding, `satisfies` — none of it environment-derived.
declare const request: { readonly body: string; readonly url: string };

function decorate(target: unknown, key: unknown): void {}

export class Handler {
  static readonly parsed = new URL(request.url);
  static #cache = new Map<string, unknown>();
  #payload = JSON.parse(request.body);
  accessor label: string = request.url.trim().toLocaleLowerCase();

  static {
    Handler.#cache.set('boot', Number(request.url.length));
  }

  @decorate
  run(): unknown {
    return this.#payload;
  }
}

export async function* chunks<T,>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item satisfies T;
}

export const View = <T,>({ rows }: { readonly rows: readonly T[] }) => (
  <section data-count={rows.length > 0 ? 'y' : 'n'}>{String(rows.length)}</section>
);

try {
  JSON.parse(request.body);
} catch {
  /* optional catch binding */
}
