// expect-count: 2
export function route(href: string) {
  const url = new URL(href);
  const params = url.searchParams;
  params.set('page', '2');
  const read = params.get('kind');
  const { searchParams: other } = url;
  other.append('tag', 'new');
  return [read, other.get('tag')];
}
