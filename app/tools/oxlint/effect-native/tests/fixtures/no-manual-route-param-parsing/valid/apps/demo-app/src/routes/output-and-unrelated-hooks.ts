import { useSearch } from '../hooks/use-search.ts';
import * as Search from '../hooks/use-search.ts';
import { useParams } from '@tanstack/react-router';

export function output(href: string, file: File) {
  const url = new URL(href);
  url.searchParams.set('page', '2');
  url['searchParams'].append('sort', 'name');
  url.searchParams.delete('old');
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const form = new FormData();
  form.append('file', file);
  const search = new URLSearchParams({ page: '2' });
  const empty = new URLSearchParams();
  return { url: url.toString(), query, form, search, empty };
}
export function unrelated() {
  useSearch({ strict: false, query: 'a' });
  Search.useSearch({ strict: false });
}
const loose = { strict: false } as const;
const strict = { strict: true } as const;
export function typed() {
  useParams({ ...loose, strict: true });
  useParams({ ...loose, ...strict });
}
