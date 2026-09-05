// expect-count: 2
export const loader = (request: { readonly url: string }) => {
  const { searchParams } = new URL(request.url);
  const url = new URL(request.url);
  const { searchParams: alias } = url;
  return {
    query: searchParams.get('q')?.trim() ?? '',
    page: Number(alias.get('page') ?? '1'),
  };
};
