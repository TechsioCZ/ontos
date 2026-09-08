// expect-count: 1
const fallback = 'https://example.test/search';

export const loaderConditional = (raw: string | null): string | null => {
  const url = raw === null ? new URL(fallback) : new URL(raw);
  return url.searchParams.get('q');
};
