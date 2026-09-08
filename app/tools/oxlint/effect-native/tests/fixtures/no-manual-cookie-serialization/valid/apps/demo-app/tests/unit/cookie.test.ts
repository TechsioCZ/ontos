// Test files are excluded by default: the audit's D tier keeps hand-written cookie fixtures.
export const fixtureHeaders = (headers: Headers): void => {
  headers.append('set-cookie', 'session=restored; Path=/; HttpOnly');
};

export const expected = ['better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'];

export interface FixtureResult {
  readonly setCookieHeaders: readonly string[];
}
