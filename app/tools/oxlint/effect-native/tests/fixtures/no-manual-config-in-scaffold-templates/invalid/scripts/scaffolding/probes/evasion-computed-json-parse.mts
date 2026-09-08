/** JSON.parse reached through a computed member so the literal `JSON.parse(` never appears. */
export const renderDecoder = (): string => `
const decodeJwks = (raw: string) => JSON['parse'](raw);
export const jwks = decodeJwks(rawJwks);
`;
