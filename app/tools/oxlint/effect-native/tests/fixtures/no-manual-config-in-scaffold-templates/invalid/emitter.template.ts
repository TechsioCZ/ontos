// expect-count: 2
// *.template.* scope.
export const body = `
const key = jwks.keys[0];
if (key['kty'] !== 'OKP') { throw configurationError('kty'); }
`;
