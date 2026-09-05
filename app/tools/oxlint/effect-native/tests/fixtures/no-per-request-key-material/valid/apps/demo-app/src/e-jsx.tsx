import type { JSX } from 'react';

const identity = <T,>(value: T): T => value;

export function Panel({ items }: { readonly items: readonly string[] }): JSX.Element {
  return (
    <section>
      {items.map((item) => (
        <span key={item}>{identity(item)}</span>
      ))}
      <>{'<not a tag>'}</>
    </section>
  );
}
