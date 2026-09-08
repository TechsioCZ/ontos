// expect-count: 3
// Class static/instance methods and a getter returning the binding.
import * as jose from 'jose';

export class Verifier {
  static async load(jwk: unknown) {
    return await jose.importJWK(jwk as never, 'EdDSA');
  }
  async verify(jwk: unknown) {
    return await jose.importJWK(jwk as never, 'EdDSA');
  }
  get loader() {
    return jose.importJWK;
  }
}
