// expect-count: 4
// C1 reports the four serialization expressions, not the erased string[] contract.
// A framework can produce that same contract; see valid/fp-framework-cookie-bridge.ts.
interface AuthConfigValue {
  readonly secureCookies: boolean;
}

export interface ImpersonationResult {
  readonly identity: string;
  readonly setCookieHeaders: readonly string[];
}

const authCookieName = (configuration: AuthConfigValue, suffix: string): string =>
  `${configuration.secureCookies ? '__Secure-' : ''}better-auth.${suffix}`;

const cookieAttributes = (configuration: AuthConfigValue): string =>
  `Path=/; HttpOnly; SameSite=Lax${configuration.secureCookies ? '; Secure' : ''}`;

export const clearAuthCookies = (configuration: AuthConfigValue): readonly string[] =>
  ['session_token', 'session_data'].map(
    (suffix) =>
      `${authCookieName(configuration, suffix)}=; ${cookieAttributes(configuration)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );

export const persistence = (maxAge: number, remember: boolean): string =>
  remember ? `; Max-Age=${maxAge}` : '';
