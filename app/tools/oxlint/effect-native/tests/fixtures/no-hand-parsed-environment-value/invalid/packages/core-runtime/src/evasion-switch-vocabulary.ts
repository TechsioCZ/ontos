// expect-count: 2
// Evasion: `switch` hand rolls exactly the closed configuration vocabulary that `=== 'production'`
// does, and the audit counts `switch (` (src 33/16) alongside `._tag ===`. The rule only visits
// BinaryExpression, so a switch over an environment value is invisible.
type Environment = Readonly<Record<string, string | undefined>>;

export const logLevel = (environment: Environment) => {
  switch (environment['LOG_LEVEL']) {
    case 'debug':
      return 10;
    case 'info':
      return 20;
    default:
      return 30;
  }
};

export const sslMode = () => {
  switch (process.env.PGSSLMODE) {
    case 'disable':
      return false;
    case 'require':
      return true;
    default:
      return undefined;
  }
};
