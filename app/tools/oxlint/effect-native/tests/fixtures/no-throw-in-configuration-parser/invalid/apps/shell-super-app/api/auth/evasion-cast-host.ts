// expect-count: 3
// A3 evasion: a cast or non-null assertion between the ambient host and `.env`. `isEnvHost` unwraps
// `ChainExpression` only, so `TSAsExpression` / `TSNonNullExpression` hide the ambient read.
export const parseSessionSecret = (): string => {
  const secret = (process as NodeJS.Process).env['BETTER_AUTH_SECRET'];
  if (secret === undefined || secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
  }
  return secret;
};

export const parseTrustedOrigins = (): readonly string[] => {
  const raw = (globalThis as typeof globalThis & { process: NodeJS.Process }).process.env[
    'ONTOS_TRUSTED_ORIGINS'
  ];
  if (raw === undefined) {
    throw new Error('ONTOS_TRUSTED_ORIGINS is required');
  }
  return raw.split(',');
};

export const parseCookieDomain = (): string => {
  const domain = process!.env['ONTOS_COOKIE_DOMAIN'];
  if (domain === undefined) {
    throw new Error('ONTOS_COOKIE_DOMAIN is required');
  }
  return domain;
};
