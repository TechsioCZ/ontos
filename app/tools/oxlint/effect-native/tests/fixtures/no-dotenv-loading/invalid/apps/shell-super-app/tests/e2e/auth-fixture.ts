// expect-count: 4
// Tests are in scope by default: E2E fixtures loading dotenv are A3 evidence sites.
import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

export const createAuthenticationFixture = () => {
  const loaded = dotenv.config({ path: '.env', quiet: true });
  dotenvExpand.expand(loaded);
  return process.env['DATABASE_URL'];
};
