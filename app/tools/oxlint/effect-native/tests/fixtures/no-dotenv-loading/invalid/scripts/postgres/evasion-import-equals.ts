// expect-count: 2
// TypeScript's `import ... = require(...)` form.
import dotenv = require('dotenv');

dotenv.config({ path: '.env' });

export const loaded = true;
