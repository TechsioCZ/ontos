// expect-count: 2
// Mirrors packages/core-runtime/src/db/config.ts (audit A3 evidence): a library module that loads
// the workspace .env by hand and then reads ambient process.env.
import { config as loadDotenv } from 'dotenv';

import { APP_ENV_PATH } from '../environment/workspace-environment.ts';

export const loadEnvironment = (): void => {
  const result = loadDotenv({ path: APP_ENV_PATH, quiet: true });
  if (result.error !== undefined) throw result.error;
};
