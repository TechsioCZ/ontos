// expect-count: 3
// A3 evasion: the parameter *type* is an environment record, but the structural check only runs when
// the parameter *name* also matches, so destructuring or renaming the bag hides the parser.
interface RawEnvironmentRecord {
  readonly [key: string]: string | undefined;
}

export const parseIssuer = ({
  ONTOS_GATEWAY_ISSUER,
}: Readonly<Record<string, string | undefined>>): string => {
  if (ONTOS_GATEWAY_ISSUER === undefined) {
    throw new Error('ONTOS_GATEWAY_ISSUER is required');
  }
  return ONTOS_GATEWAY_ISSUER;
};

export const parseJwks = (vars: Readonly<Record<string, string | undefined>>): string => {
  const raw = vars['ONTOS_GATEWAY_PUBLIC_JWKS'];
  if (raw === undefined) {
    throw new Error('ONTOS_GATEWAY_PUBLIC_JWKS is required');
  }
  return raw;
};

export const parseAudience = (raw: RawEnvironmentRecord): string => {
  const audience = raw['ONTOS_GATEWAY_AUDIENCE'];
  if (audience === undefined) {
    throw new Error('ONTOS_GATEWAY_AUDIENCE is required');
  }
  return audience;
};
