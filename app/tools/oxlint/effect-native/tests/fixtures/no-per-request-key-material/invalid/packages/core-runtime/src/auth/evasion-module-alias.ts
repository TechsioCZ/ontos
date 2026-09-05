// expect-count: 1
// EVASION: one-hop module-scope alias of the imported binding, then called per request.
import { importJWK } from 'jose';

const load = importJWK;

export const verify = async (jwk: unknown) => await load(jwk as never, 'EdDSA');
