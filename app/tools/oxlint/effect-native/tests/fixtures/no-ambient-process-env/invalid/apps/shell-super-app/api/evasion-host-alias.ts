// A3: binding the ambient host to a local first defeats an identifier-only host check.
const proc = process;
const runtime = globalThis.process;

export const databaseUrl = proc.env["DATABASE_URL"];

export const authUrl = runtime.env["BETTER_AUTH_URL"];
