// FALSE POSITIVE regression fixture (adversarial review).
//
// The rule's own docblock promises: "Enum/namespace objects that merely happen to be called `env`
// ... never report." `valid/apps/shell-super-app/src/env-lookalikes.tsx` only pins that promise for
// lowercase keys. It does NOT hold once such an object uses SCREAMING_SNAKE keys, because
// `isEnvironmentRecord` matches on the *identifier name* alone and never consults the declarator,
// even when the initialiser is provably an object literal of string literals.
//
// Nothing below reads any environment. `env` is a module constant whose every value is written
// here in the source. There is no `Config.string(...)` to declare and no ConfigProvider that could
// ever supply these, so every diagnostic on this file is spurious.
const env = {
	API_VERSION: 'v2',
	REGION: 'eu-central-1',
} as const;

export const regionSlug = env.REGION.toLowerCase();
export const isV2 = env.API_VERSION === 'v2';
export const regionIsScoped = env.REGION.length > 0;
export const regionPrefix = env.REGION.split('-')[0];
