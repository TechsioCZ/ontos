// @effect-diagnostics processEnv:off nodeBuiltinImport:off
import process from 'node:process';

export interface CoreRuntimeEnv {
  databaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  spiceDbEndpoint: string;
  spiceDbPresharedKey: string;
  spiceDbInsecure: boolean;
}

export const readCoreRuntimeEnv = (): CoreRuntimeEnv => ({
  betterAuthSecret: process.env['BETTER_AUTH_SECRET'] ?? 'local-dev-better-auth-secret-change-me',
  betterAuthUrl: process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3020',
  databaseUrl: process.env['DATABASE_URL'] ?? 'postgres://ontos:ontos@localhost:5432/ontos',
  spiceDbEndpoint: process.env['SPICEDB_ENDPOINT'] ?? 'localhost:50051',
  spiceDbInsecure: process.env['SPICEDB_INSECURE'] !== 'false',
  spiceDbPresharedKey: process.env['SPICEDB_PRESHARED_KEY'] ?? 'local-spicedb-key',
});
