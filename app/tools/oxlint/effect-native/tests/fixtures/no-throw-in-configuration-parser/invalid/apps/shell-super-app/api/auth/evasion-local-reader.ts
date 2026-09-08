// expect-count: 2
// A3 evasion: the ambient read lives in a file-local reader whose name is not in
// `environmentReaders`. The local call graph already exists, but marks only propagate downward
// (parser -> helper), never upward from an environment-reading helper to the parser that throws.
const readSetting = (key: string): string | undefined => process.env[key];

export const parseGatewayIssuer = (): string => {
  const issuer = readSetting('ONTOS_GATEWAY_ISSUER')?.trim();
  if (issuer === undefined || issuer.length === 0) {
    throw new Error('ONTOS_GATEWAY_ISSUER is required');
  }
  if (!issuer.startsWith('https://')) {
    throw new Error('ONTOS_GATEWAY_ISSUER must use HTTPS');
  }
  return issuer;
};
