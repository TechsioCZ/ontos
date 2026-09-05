// expect-count: 5
// Evasion: MEMBER_PARSE_OPS is a closed list, so exact synonyms of ops it already reports slip
// through — `.substring` for `.slice`, `.toLocaleLowerCase` for `.toLowerCase`, `.indexOf` for
// `.includes`, plus `.at`/`.padStart`.
type Environment = Readonly<Record<string, string | undefined>>;

export const shape = (environment: Environment) => {
  const raw = environment['DATABASE_URL'];
  return {
    at: raw?.at(0),
    marker: raw?.indexOf('://'),
    padded: environment['REPLICA_ID']?.padStart(4, '0'),
    prefix: raw?.substring(0, 8),
    scheme: raw?.toLocaleLowerCase(),
  };
};
