// expect-count: 1
export const loader = (request: { readonly url: string }): string =>
  URL.parse(request.url)?.searchParams.get('q')?.trim() ?? '';
