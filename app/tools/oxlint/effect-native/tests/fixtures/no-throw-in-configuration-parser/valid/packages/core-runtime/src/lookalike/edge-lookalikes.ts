// Lookalikes that must stay quiet: a deployment environment *name*, a shadowed ambient host, a
// non-environment record parameter, and type-only mentions of the environment.
declare module 'node:process' {
  interface Process {
    readonly marker: string;
  }
}

export type AmbientEnvironment = typeof process.env;
export type GatewayIssuer = AmbientEnvironment['ONTOS_GATEWAY_ISSUER'];

export const describeStage = (environment: string): string => {
  if (environment.length === 0) {
    throw new Error('a deployment environment name is required');
  }
  return environment.trim().toUpperCase();
};

export const readShadowedHost = (): string => {
  const process = { env: { PORT: '3000' } as Record<string, string> };
  const port = process.env['PORT'];
  if (port === undefined) {
    throw new Error('PORT is required');
  }
  return port;
};

export const buildHeaders = (headers: Record<string, string>): Headers => {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (key.length === 0) {
      throw new TypeError('header names must not be empty');
    }
    result.set(key, value);
  }
  return result;
};

export const translate = (translations: Record<string, string>, key: string): string => {
  const value = translations[key];
  if (value === undefined) {
    throw new Error(`missing translation ${key}`);
  }
  return value;
};
