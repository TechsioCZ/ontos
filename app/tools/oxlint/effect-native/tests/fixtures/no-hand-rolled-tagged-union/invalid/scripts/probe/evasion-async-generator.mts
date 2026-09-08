// expect-count: 2
type Chunk = { readonly _tag: 'chunk'; readonly bytes: number } | { readonly _tag: 'eof' };

export async function* stream(): AsyncGenerator<Chunk, void, undefined> {
  yield { _tag: 'chunk', bytes: 1 };
  yield { _tag: 'eof' };
}
