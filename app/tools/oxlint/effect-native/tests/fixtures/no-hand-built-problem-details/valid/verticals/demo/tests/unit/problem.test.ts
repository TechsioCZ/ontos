declare const expect: (value: unknown) => { toEqual: (other: unknown) => void };
declare const test: (name: string, run: () => void) => void;
declare const decode: (value: unknown) => unknown;
declare const error: { readonly message: string };

// D tier: deliberately malformed / hand-built fixtures in tests prove rejection behaviour.
test('rejects a malformed problem', () => {
  expect(
    decode({
      _tag: 'ContactsUnavailableProblem',
      detail: error.message,
      retryable: true,
      status: 503,
      title: 'Contacts unavailable',
      type: 'https://ontos.dev/problems/contacts-unavailable',
    }),
  ).toEqual(undefined);
});
