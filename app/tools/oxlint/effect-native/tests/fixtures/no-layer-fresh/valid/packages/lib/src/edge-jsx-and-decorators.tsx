import { Layer } from 'effect';

declare const deco: (target: unknown, context: unknown) => void;

export class Decorated {
  @deco accessor value = 1;
  @deco method(): typeof Layer.merge { return Layer.merge; }
}

// JSX attributes, string literals and class names named `fresh` are not the effect member.
export const Element = () => (
  <>
    <div fresh="yes" data-fresh={1} className="fresh">{'Layer.fresh'}</div>
    <section aria-label="fresh" />
  </>
);
