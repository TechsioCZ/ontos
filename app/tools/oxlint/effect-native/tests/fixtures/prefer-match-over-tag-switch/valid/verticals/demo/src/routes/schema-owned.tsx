import { Match, Schema } from 'effect';

import type { ReactElement } from 'react';

const PageState = Schema.Union([
  Schema.TaggedStruct('Loading', {}),
  Schema.TaggedStruct('Ready', { rows: Schema.Array(Schema.String) }),
]);
type PageState = Schema.Schema.Type<typeof PageState>;

declare const Spinner: () => ReactElement;
declare const View: (props: { readonly rows: readonly string[] }) => ReactElement;

/** Schema owns the vocabulary; Match owns the branching. */
export function Page(props: { readonly state: PageState }): ReactElement {
  return Match.value(props.state).pipe(
    Match.tag('Loading', () => <Spinner />),
    Match.tag('Ready', (ready) => <View rows={ready.rows} />),
    Match.exhaustive,
  );
}
