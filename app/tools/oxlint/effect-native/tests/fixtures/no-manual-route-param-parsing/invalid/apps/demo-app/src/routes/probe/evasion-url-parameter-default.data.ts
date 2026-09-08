// expect-count: 1
const fallback = 'https://example.test/search';

export const loaderDefault = (url = new URL(fallback)): string | null => url.searchParams.get('page');
