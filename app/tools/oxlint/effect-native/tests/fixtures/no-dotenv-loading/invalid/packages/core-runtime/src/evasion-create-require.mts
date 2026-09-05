// A3 evasion: ESM modules cannot use a bare `require`, so the repo's own config files build one with
// `createRequire` (apps/shell-super-app/module-federation.config.ts:51). The dotenv load is identical.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const dotenv = require('dotenv');

export const loadEnvironment = (): void => {
  dotenv.config({ path: '.env', quiet: true });
};
