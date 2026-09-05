import { useParams } from '@tanstack/react-router';
export function link(href: string) {
  const url = new URL(href);
  const params = (url.searchParams satisfies URLSearchParams);
  const alias = params;
  alias.set('page', '2');
  const { searchParams: more } = url;
  more.append('tag', 'new');
  return url.toString();
}
export function typedAfterWrite() {
  let options = { strict: false };
  options = { strict: true };
  return useParams(options);
}
