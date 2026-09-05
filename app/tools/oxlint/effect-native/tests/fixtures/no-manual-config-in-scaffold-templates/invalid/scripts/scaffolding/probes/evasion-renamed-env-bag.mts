/** Same ambient lookup as the stale template with the bag renamed away from `environment`. */
export const renderBoundary = (appId: string): string => `
export const loadGatewayConfig = (settings: Record<string, string | undefined>) => ({
  appId: '${appId}',
  issuer: settings['ONTOS_GATEWAY_ISSUER'],
  jwks: secrets['ONTOS_GATEWAY_PUBLIC_JWKS'],
});
`;
