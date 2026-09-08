// expect-count: 8
export interface DatabaseConfigValue {
  readonly connectionString: string;
  readonly database: string;
  readonly host: string;
  readonly password: string;
  readonly user: string;
}

export interface SpiceDbConfigValue {
  readonly endpoint: string;
  readonly insecureLocal: boolean;
  readonly preSharedKey: string;
}

export interface GatewayIssuerConfigValue {
  readonly issuer: string;
  readonly privateJwk: string;
  readonly signingKey?: string;
}

export class RuntimeCredentials {
  readonly clientSecret: string = '';
  readonly tenantId: string = '';
  accessor accessToken: string = '';
}

export const connect = (connectionString: string, poolSize: number): string =>
  `${connectionString}:${poolSize}`;

export function issue(subject: string, { ttlSeconds }: { readonly ttlSeconds: number }): string {
  return `${subject}:${ttlSeconds}`;
}
