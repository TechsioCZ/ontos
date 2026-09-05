import type { ReactElement } from 'react';

// Open unions: an escape hatch member keeps the vocabulary unclosed.
export type Loose = 'primary' | 'secondary' | (string & {});
export type Interp = `/${string}` | `#${string}`;
export type Numeric = 'a' | 1 | 2;
export type Booleanish = 'a' | true | false;
export type WithRef = 'fallback' | ReactElement;
export type Widened = Uppercase<'a'> | 'b';

// `as` / `satisfies` carry a literal union in an *expression*, not in an alias declaration.
export function Widget(): ReactElement {
  const tone = 'primary' as 'primary' | 'secondary';
  const checked = tone satisfies 'primary' | 'secondary';
  return <div data-tone={checked} />;
}
