/** Ambient configuration read through dot access instead of Config/ConfigProvider (A3). */
export const renderBoundary = (appId: string): string => `
export const loadGatewayConfig = (environment: Record<string, string | undefined>) => {
  const issuer = environment.ONTOS_GATEWAY_ISSUER;
  const jwks = environment.ONTOS_GATEWAY_PUBLIC_JWKS;
  return { appId: '${appId}', issuer, jwks };
};
`;
