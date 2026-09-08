class Branded {
  static readonly #brand = 1;
  static is(value: object): boolean {
    return #brand in value;
  }
}

/** Dictionary access, a `for…in` walk and a dynamic template key are not hand-written key sets. */
export const dynamicMembership = (registry: Record<string, unknown>, prefix: string): boolean =>
  Object.hasOwn(registry, prefix) || `${prefix}Id` in registry;

export const keysOf = (record: Record<string, unknown>): readonly string[] => {
  const out: string[] = [];
  for (const key in record) out.push(key);
  return out;
};

export const numericProbe = (raw: readonly unknown[]): boolean => typeof raw[0] === 'string';

export { Branded };
