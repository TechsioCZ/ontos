// expect-count: 3
// Evasion: express the credential as a getter/setter instead of a field. `vault.password` is
// still a plain string to every consumer, `JSON.stringify` still serialises the interface shape,
// but the annotation now hangs off a TSMethodSignature / FunctionExpression return type.
export interface VaultShape {
  get secret(): string;
}

export class Vault {
  get password(): string {
    return '';
  }

  set connectionString(value: string) {
    void value;
  }
}
