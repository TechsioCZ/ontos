// expect-count: 4
export const loader = (raw: string) => {
  const primary = new URL(raw);
  const alias = primary;
  const viaAlias = alias.searchParams.get('q');
  let target;
  ({ searchParams: target } = alias);
  const fallback = URL.parse(raw) ?? new URL('https://example.test');
  const page = fallback.searchParams.get('page');
  const Sp = globalThis.URLSearchParams;
  const extra = new Sp(raw).get('extra');
  return { extra, page, target, viaAlias };
};
