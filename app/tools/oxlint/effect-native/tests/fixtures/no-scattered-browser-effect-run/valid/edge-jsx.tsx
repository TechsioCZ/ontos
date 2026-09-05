// JSX-only module: fragments, member components, spreads and conditionals must not crash the rule.
import { Fragment } from 'react';

const Panel = {
  Body: (props: { readonly label: string }) => <span>{props.label}</span>,
};

export const View = ({ items }: { readonly items: ReadonlyArray<string> }) => (
  <Fragment>
    <Panel.Body label="header" />
    {items.length > 0 ? (
      <ul {...{ role: 'list' }}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    ) : null}
  </Fragment>
);
