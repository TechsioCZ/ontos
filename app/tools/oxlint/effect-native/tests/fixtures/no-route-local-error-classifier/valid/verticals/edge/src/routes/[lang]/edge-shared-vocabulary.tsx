// The target state: the route consumes the shared vocabulary and never touches `_tag` itself.
import { Match } from 'effect';

type ContactsFailure =
  | { readonly _tag: 'ContactsForbiddenProblem' }
  | { readonly _tag: 'ContactsNotFoundProblem' };
type FrontendFailure = { readonly state: 'forbidden' | 'not_found' };

declare const toFrontendFailure: (failure: ContactsFailure) => FrontendFailure;
declare const t: (key: string) => string;

export const bannerCopy = (failure: FrontendFailure) => t(`contacts.error.${failure.state}`);

export const CustomerListBanner = ({ error }: { readonly error: ContactsFailure | undefined }) =>
  error === undefined ? <p>ready</p> : <p>{bannerCopy(toFrontendFailure(error))}</p>;

export const rowClassName = (index: number) => (index % 2 === 0 ? 'even' : 'odd');

export const matchedCopy = (failure: ContactsFailure) =>
  Match.value(failure).pipe(
    Match.tag('ContactsForbiddenProblem', () => 'forbidden'),
    Match.tag('ContactsNotFoundProblem', () => 'not_found'),
    Match.exhaustive,
  );
