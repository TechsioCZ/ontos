// expect-count: 4
// CommonJS-shaped loading in an operational script, plus a bare side-effect require.
const dotenv = require('dotenv');
const { config: loadDotenv } = require('@dotenvx/dotenv');

dotenv.config({ path: '.env' });
loadDotenv({ path: '.env' });
