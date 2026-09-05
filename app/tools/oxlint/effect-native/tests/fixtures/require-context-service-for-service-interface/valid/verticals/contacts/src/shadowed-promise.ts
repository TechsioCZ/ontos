/** No effect import at all and a locally declared `Promise` type: nothing here is an Effect seam. */
type Promise<A> = { readonly value: A };

export interface LocalCacheRepository {
  readonly read: (key: string) => Promise<string>;
}
