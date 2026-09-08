// expect-count: 7
// Audit A3 evidence shape: apps/shell-super-app/api/auth/gateway-issuer-config.ts:57.
const { DATABASE_URL } = process.env;
const rawJwk = process.env['GATEWAY_PRIVATE_JWK'];

export const databaseUrl = new URL(DATABASE_URL ?? '');
export const privateJwk = JSON.parse(rawJwk ?? '{}');
export const port = Number(process.env.PORT ?? '3020');
export const debug = process.env.DEBUG === 'true';
export const origins = process.env.ALLOWED_ORIGINS?.split(',');
export const issuedAt = new Date(process.env.ISSUED_AT ?? '');
export const level = parseInt(process.env.LOG_LEVEL ?? '0', 10);
