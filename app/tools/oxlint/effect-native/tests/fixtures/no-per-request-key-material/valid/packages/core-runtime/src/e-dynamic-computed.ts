import * as jose from 'jose';

declare const name: 'importJWK';

export const a = (jwk: unknown) => jose[name](jwk as never, 'EdDSA');
