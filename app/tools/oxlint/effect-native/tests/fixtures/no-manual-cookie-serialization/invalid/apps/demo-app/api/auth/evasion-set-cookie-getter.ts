// A getter keyed `set-cookie` is not a hand-built *value* (its value node is a function), so the
// property is not reported — and the returned cookie string is suppressed as covered by it.
export const headers = {
  get 'set-cookie'() {
    return `session=; Path=/; HttpOnly; Max-Age=0`;
  },
};
