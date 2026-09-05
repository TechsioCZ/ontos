// expect-count: 2
// Route components destructure the failure out of props; the `_tag` discrimination is then read
// off a binding the rule never links back to the parameter.
type ContactsFailure = { readonly _tag: 'ContactsForbiddenProblem' | 'ContactsNotFoundProblem' };

export const CustomerListBanner = ({ error }: { readonly error: ContactsFailure }) => (
  <p data-state={error._tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found'}>banner</p>
);

export function ContactDetailBanner({ failure }: { readonly failure: ContactsFailure }) {
  switch (failure._tag) {
    case 'ContactsForbiddenProblem': {
      return <p>forbidden</p>;
    }
    default: {
      return <p>not found</p>;
    }
  }
}
