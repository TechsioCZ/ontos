// expect-count: 1
/** The offending line only exists in a template nested inside an interpolation. */
export const renderBoundary = (secure: boolean): string => `
export const gatewayConfig = {
  ${secure ? `issuer: process.env.ONTOS_GATEWAY_ISSUER` : `issuer: 'http://localhost:3000'`},
};
`;
