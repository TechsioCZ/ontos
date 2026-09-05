// expect-count: 6
// A3: gateway/auth configuration, including JSON-valued config and secrets, read ambiently.
export const issuer = process.env.ONTOS_GATEWAY_ISSUER ?? "";

export const jwks: unknown = JSON.parse(process.env.ONTOS_GATEWAY_PUBLIC_JWKS ?? "{}");

export const bunSessionSecret = Bun.env.SESSION_SECRET;

export const denoSessionSecret = Deno.env.get("SESSION_SECRET");

export const publicApiUrl = window.process.env.PUBLIC_API_URL;

const { env: ambientEnvironment } = globalThis.process;

export const impersonationHeader = ambientEnvironment.ONTOS_IMPERSONATION_HEADER;
