import { Effect } from 'effect';

/** Crash probe: a `.tsx` module with fragments and generic components (`includeTsx` is false). */
export interface ContactsListRepository {
  readonly load: (id: string) => Effect.Effect<readonly string[], Error>;
}

export const ContactsList = <Item extends string>({ items }: { readonly items: readonly Item[] }) => (
  <>
    {items.map((item) => (
      <span key={item}>{item}</span>
    ))}
  </>
);
