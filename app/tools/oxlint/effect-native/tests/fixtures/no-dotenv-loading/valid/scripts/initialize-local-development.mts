// D tier: this bootstrap script authors developer .env files; it is on the default allowPaths list.
import { config as loadDotenv } from 'dotenv';

const result = loadDotenv({ path: '.env', quiet: true });
export const loaded = result.parsed ?? {};
