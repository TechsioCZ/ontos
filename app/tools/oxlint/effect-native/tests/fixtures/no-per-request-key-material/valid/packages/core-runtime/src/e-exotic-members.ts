// Pathological member shapes must not crash and must not report.
class Base {
  importKey(value: string): string {
    return value;
  }
}

export class Child extends Base {
  #crypto = { subtle: { importKey: (value: string) => value } };

  override importKey(value: string): string {
    return super.importKey(value) + this.#crypto.subtle.importKey(value);
  }
}

const tag = (parts: TemplateStringsArray, ...values: readonly string[]) => parts.join('') + values.join('');

// Nested template literals in a NON-generator file are not scanned.
export const rendered = (name: string): string => tag`
  outer ${`inner createLocalJWKSet(${name}) importJWK(${name})`} end
`;

export const dynamic = (bag: Record<string, (v: string) => string>, key: string) => bag[key]?.('raw');
