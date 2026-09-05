// expect-count: 3
// async generator, `as` cast callee, parenthesized optional chain, `satisfies` callee.
import { importJWK } from 'jose';
import * as jose from 'jose';

type Loader = (value: unknown) => Promise<unknown>;

export async function* keys(jwks: readonly unknown[]) {
  for (const jwk of jwks) yield await (importJWK as Loader)(jwk);
}

export const chained = async (jwk: unknown) => await (jose?.importJWK)?.(jwk as never, 'EdDSA');

export const satisfied = async (jwk: unknown) => await (importJWK satisfies Loader)(jwk);
