// expect-count: 4
// Evasion: unary `+` is `Number(...)`; `Date.parse`/`URL.parse`/`URL.canParse` are `new Date`/
// `new URL`. All four are the same hand written codec written a different way.
type Environment = Readonly<Record<string, string | undefined>>;

export const parse = (environment: Environment) => ({
  canParse: URL.canParse(environment['DATABASE_URL'] ?? ''),
  issuedAt: Date.parse(environment['ISSUED_AT'] ?? ''),
  port: +(environment['SHELL_SUPER_APP_PORT'] ?? '3020'),
  url: URL.parse(environment['DATABASE_URL'] ?? ''),
});
