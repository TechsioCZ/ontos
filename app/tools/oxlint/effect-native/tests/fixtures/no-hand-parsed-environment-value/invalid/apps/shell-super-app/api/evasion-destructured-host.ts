// expect-count: 3
// Evasion: the `env` bag lifted off the host under a different name, or the host itself aliased.
// `no-throw-in-configuration-parser` handles `const { env } = process`; this rule does not.
const { env: bag } = process;
const processRef = globalThis.process;

export const port = Number(bag.PORT ?? '3020');
export const featureFlag = bag['FEATURE_CONTACTS'] === 'true';
export const databaseUrl = new URL(processRef.env.DATABASE_URL ?? '');
