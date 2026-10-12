/** Catalogue headings arrive in capitals; checkout uses sentence case from the design. */
export function formatCartProductName(name: string): string {
  if (name !== name.toLocaleUpperCase("cs-CZ")) return name;

  const readable = name
    .toLocaleLowerCase("cs-CZ")
    .replace(
      /(?<![\p{L}\p{N}])(?:din|iso|en|ansi|astm|aisi|čsn|dn|pn|km|mb|a[1245]|[hrdml](?=\s*\d))(?=[\d\s/.,()-]|$)/gu,
      (designation) => designation.toLocaleUpperCase("cs-CZ"),
    );
  return readable.replace(/^\s*\p{L}/u, (start) => start.toLocaleUpperCase("cs-CZ"));
}
