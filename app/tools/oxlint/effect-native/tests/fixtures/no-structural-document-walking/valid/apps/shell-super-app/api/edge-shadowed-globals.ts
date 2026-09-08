/** Shadowed `JSON` / `Object` / `Array` are not the globals the rule reasons about. */
const JSON = { stringify: (value: unknown): string => String(value) };
const Objects = Object;

export const shadowedJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const shadowedObject = (
  Object: { readonly hasOwn: (o: object, k: string) => boolean },
  doc: object,
): boolean => Object.hasOwn(doc, 'verticals');

export const shadowedArray = (
  Array: { readonly isArray: (v: unknown) => boolean },
  raw: unknown,
): boolean => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

export const keysOf = (record: Record<string, unknown>): readonly string[] => Objects.keys(record);
