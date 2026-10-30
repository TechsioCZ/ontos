type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
type Dictionary<Value> = { [key: string]: Value };
type Erased<Value> = { [Key in keyof Value]: unknown };
interface DraftLine { readonly productId: string; readonly quantity: number; }

export const open: Record<string, unknown> = { productId: 'product', quantity: 1 };
export const mutableOpen: Mutable<Record<string, unknown>> = { productId: 'product', quantity: 1 };
export const generic: Dictionary<unknown> = { productId: 'product', quantity: 1 };
export const erased: Erased<DraftLine> = { productId: 'product', quantity: 1 };
export const replaced: { [Key in keyof DraftLine]: unknown } = { productId: 'product', quantity: 1 };
export const remapped: { [Key in keyof DraftLine as string]: DraftLine[Key] } = { productId: 'product', quantity: 1 };
export const optional: { [Key in keyof DraftLine]?: DraftLine[Key] } = { productId: 'product', quantity: 1 };
export const mappedOpen: { [Key in keyof Record<string, unknown>]: Record<string, unknown>[Key] } = { productId: 'product', quantity: 1 };
export const extractedOpen: Mutable<Extract<Record<string, unknown>, object>> = { productId: 'product', quantity: 1 };
