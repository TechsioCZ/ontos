export type LocaleCatalog = LocaleCatalogGroup | string;
export type LocaleCatalogGroup = Readonly<Record<string, LocaleCatalog>>;

const isLocaleText = (value: LocaleCatalog): value is string => value === String(value);
const isRuntimeObject = <Value>(value: Value): value is Value & object =>
  value !== null && Object(value) === value;

export const parseLocaleCatalog = <Input>(input: Input): LocaleCatalog => {
  if (input === String(input)) {
    return String(input);
  }
  if (!isRuntimeObject(input) || Array.isArray(input)) {
    throw new TypeError('Locale catalog values must be text or keyed groups');
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, parseLocaleCatalog(value)]),
  );
};

export const parseLocaleCatalogGroup = <Input>(input: Input): LocaleCatalogGroup => {
  const catalog = parseLocaleCatalog(input);
  if (isLocaleText(catalog)) {
    throw new TypeError('Locale catalog root must be a keyed group');
  }
  return catalog;
};

export const translateCatalog = (catalog: LocaleCatalog, key: string): string => {
  let current: LocaleCatalog | undefined = catalog;
  for (const segment of key.split('.')) {
    if (current === undefined || isLocaleText(current)) {
      return key;
    }
    current = current[segment];
  }
  return current !== undefined && isLocaleText(current) ? current : key;
};

export const flattenCatalogKeys = (catalog: LocaleCatalogGroup, prefix = ''): string[] =>
  Object.entries(catalog)
    .flatMap(([key, child]) => {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      return isLocaleText(child) ? [path] : flattenCatalogKeys(child, path);
    })
    .toSorted();
