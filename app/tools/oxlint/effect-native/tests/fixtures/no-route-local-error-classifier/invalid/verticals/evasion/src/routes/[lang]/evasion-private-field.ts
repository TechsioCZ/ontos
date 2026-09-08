// expect-count: 1
// A `#`-prefixed class field key is a PrivateIdentifier, so the `classify*` name is dropped.
type ContactsFailure = { readonly _tag: 'ContactsForbiddenProblem' | 'ContactsNotFoundProblem' };

export class ContactsPanel {
  readonly #classifyPanelError = (error: ContactsFailure) =>
    error._tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found';

  state(error: ContactsFailure) {
    return this.#classifyPanelError(error);
  }
}
