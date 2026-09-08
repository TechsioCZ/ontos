// Outside `routeGlobs`: API clients are covered by other findings, not A9 route parsing.
export const buildQuery = (search: string) => {
  const parameters = new URLSearchParams(search);
  const url = new URL('https://example.test/contacts');
  const body = new FormData();
  return { body, offset: parameters.get('offset'), query: url.searchParams.get('q') };
};
