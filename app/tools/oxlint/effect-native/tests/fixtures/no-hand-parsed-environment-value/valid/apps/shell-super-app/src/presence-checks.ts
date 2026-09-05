// Presence checks carry no configuration vocabulary to move into a Config, so `undefined`/`null`
// comparisons and pass-through reads never report.
type Environment = Readonly<Record<string, string | undefined>>;

export const summarise = (environment: Environment) => {
  const endpoint = environment['SPICEDB_ENDPOINT'];
  const key = environment['SPICEDB_PRESHARED_KEY'];
  if (endpoint === undefined || key === null) return { configured: false } as const;
  return { configured: true, endpoint, key } as const;
};

export const forward = (environment: Environment) => ({ ...environment });
export const passThrough = (environment: Environment) => environment['DATABASE_URL'];
