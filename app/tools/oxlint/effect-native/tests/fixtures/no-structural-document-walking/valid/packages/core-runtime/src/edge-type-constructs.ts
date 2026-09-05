type Identifier = `${string}-id`;

declare module 'virtual:topology' {
  const value: unknown;
  export default value;
}

export const branded = (id: Identifier): string => id;

export const keyed = <T extends object>(value: T, key: keyof T): unknown => value[key];
