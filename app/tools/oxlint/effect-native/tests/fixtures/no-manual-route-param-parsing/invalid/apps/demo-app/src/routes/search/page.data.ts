// expect-count: 3
interface LoaderArguments {
  readonly request: { readonly url: string };
}

export const loader = ({ request }: LoaderArguments) => {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  const page = new URL(request.url).searchParams.get('page') ?? '1';
  let alternate;
  alternate = new URL(request.url);
  const sort = alternate?.['searchParams'].get('sort') ?? 'name';
  return { page, query, sort };
};
