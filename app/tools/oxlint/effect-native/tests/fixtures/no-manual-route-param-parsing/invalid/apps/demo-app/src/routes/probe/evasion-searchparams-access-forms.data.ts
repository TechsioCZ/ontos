// expect-count: 3
export const loader = (request: { readonly url: string }) => {
  const direct = new URL(request.url)?.searchParams.get('q');
  const url = new URL(request.url);
  const computed = url['searchParams'].get('page');
  const cast = (new URL(request.url) as URL).searchParams.get('sort');
  return { cast, computed, direct };
};
