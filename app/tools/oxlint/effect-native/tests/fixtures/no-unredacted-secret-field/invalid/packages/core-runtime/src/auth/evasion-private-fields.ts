// expect-count: 2
// A3 requires credential representation as Redacted, including private storage.
// Native # fields are not shown by ordinary util.inspect; privacy is not itself a Redacted value.
// This regression checks representation, not a claim that inspection reveals private slots.
export class TokenStore {
  readonly #secret: string = '';
  static #clientSecret: string = '';
  #rotations: number = 0;

  rotate(): number {
    return this.#rotations;
  }
}
