type JsonLdPrimitive = string | number | boolean | null;
type JsonLdValue = JsonLdPrimitive | readonly JsonLdValue[] | { readonly [key: string]: JsonLdValue };
type JsonLdObject = Readonly<Record<string, JsonLdValue>>;
export type RouteJsonLd = JsonLdObject | readonly JsonLdObject[];
