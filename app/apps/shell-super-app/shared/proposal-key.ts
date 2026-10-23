/** Splits a module-owned queue key; an item or batch ID may itself contain colons. */
export const parseLegacyKey = (key: string): { readonly appId: string; readonly id: string } | undefined => {
  if (!key.startsWith('legacy:')) return undefined;
  const rest = key.slice('legacy:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return undefined;
  const id = rest.slice(separator + 1);
  return id === '' ? undefined : { appId: rest.slice(0, separator), id };
};
