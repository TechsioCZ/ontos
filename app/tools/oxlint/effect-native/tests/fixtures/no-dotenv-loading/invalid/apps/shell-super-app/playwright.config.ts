// expect-count: 2
import { config as loadDotenv } from 'dotenv';

import { APP_ENV_PATH } from './src/environment.ts';

loadDotenv({ path: APP_ENV_PATH, quiet: true });

export default { testDir: './tests/e2e' };
