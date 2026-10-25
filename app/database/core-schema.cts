import { makeCoreMigrationSchema } from './core-schema.ts';
import { APP_DATABASE_IDENTITY_ENROLLMENT } from './identity-enrollment.ts';

// Drizzle Kit loads .cts through its TypeScript loader and enumerates module.exports.
// A nested ESM default export or descriptor array is not traversed by that collector.
const migrationSchema = makeCoreMigrationSchema(APP_DATABASE_IDENTITY_ENROLLMENT);
export = migrationSchema;
