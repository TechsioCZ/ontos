import { Match } from 'effect';
import { toFrontendFailure } from '../../../errors/frontend-failure.ts';
import type { ContactsFailure } from '../../../errors/frontend-failure.ts';

type Row = { readonly id: string; readonly name: string };

// Consuming the shared vocabulary is the target state.
export const CustomersPage = ({ error, rows }: { error?: ContactsFailure; rows: readonly Row[] }) => {
  const state = error === undefined ? 'ready' : toFrontendFailure(error);
  return (
    <ul data-state={state}>
      {rows.map((row) => (
        <li key={row.id}>{row.name}</li>
      ))}
    </ul>
  );
};

// Exhaustive `Match` over the shared union, still not a local `_tag` switch.
export const bannerFor = (failure: ContactsFailure) =>
  Match.value(failure).pipe(
    Match.tag('ContactsForbiddenProblem', () => 'forbidden'),
    Match.tag('ContactsNotFoundProblem', () => 'not_found'),
    Match.exhaustive,
  );

// Non-error helpers whose names merely start with `class...`/contain `error` copy.
export const className = (row: Row) => `row-${row.id}`;
export const classNamesFor = (rows: readonly Row[]) => rows.map((row) => row.id).join(' ');
export const errorCopyFor = (locale: string) => (locale === 'cs' ? 'Chyba' : 'Error');

// Reads `_tag` off something that is not one of its own parameters.
const ambientFailure: ContactsFailure = { _tag: 'ContactsNotFoundProblem' };
export const ambientState = (rows: readonly Row[]) =>
  ambientFailure._tag === 'ContactsNotFoundProblem' ? rows.length : 0;
