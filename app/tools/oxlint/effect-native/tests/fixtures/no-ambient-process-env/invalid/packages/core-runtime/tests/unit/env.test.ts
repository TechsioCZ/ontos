// expect-count: 6
// B2: a test configuring itself by mutating the process-global environment.
const previousNodeEnvironment = process.env.NODE_ENV;

process.env.ONTOS_GATEWAY_PUBLIC_JWKS = JSON.stringify({ keys: [] });

process.env["DATABASE_URL"] ??= "postgres://localhost/ontos_test";

delete process.env["DATABASE_URL"];

Object.assign(process.env, { NODE_ENV: "test" });

Reflect.deleteProperty(process.env, "PGHOST");

export const restored = previousNodeEnvironment;
