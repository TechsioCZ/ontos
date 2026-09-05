// expect-count: 1
// B4 correction: the scalar-only nested href builder is presentation data, not collaborators.
import { Effect } from 'effect';

/** Generic arrow in a `.tsx` file — the `<T,>` disambiguating comma must not hide the parameters. */
export const buildRowRenderer = <T,>(rows: readonly T[], locale: string, page: number, query: string) => (
  <ul>
    {rows.map((row, index) => (
      <li key={index}>{`${locale}/${page}/${query}/${String(row)}`}</li>
    ))}
  </ul>
);

/** Nested inside a component, next to JSX and optional chaining. */
export const ContactsPage = (props: { readonly query?: { readonly term?: string } }) => {
  const makeCustomerHref = (lang: string, id: string, term: string, page: number) =>
    `/${lang}/contacts/${id}?q=${term}&p=${page}`;
  return <a href={makeCustomerHref('en', '1', props.query?.term ?? '', 1)}>contacts</a>;
};

export const ContactsLive = Effect.succeed(ContactsPage);
