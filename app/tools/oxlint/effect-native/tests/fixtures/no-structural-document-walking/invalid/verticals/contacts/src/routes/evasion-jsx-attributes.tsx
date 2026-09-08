// expect-count: 3
import { Predicate } from 'effect';

export const Panel = ({ decoded }: { readonly decoded: Record<string, unknown> }): JSX.Element => (
  <section data-ok={'verticals' in decoded} data-kind={Predicate.isString(decoded['kind']) ? 'k' : 'n'}>
    {typeof decoded['label'] === 'string' ? <span>{String(decoded['label'])}</span> : null}
  </section>
);
