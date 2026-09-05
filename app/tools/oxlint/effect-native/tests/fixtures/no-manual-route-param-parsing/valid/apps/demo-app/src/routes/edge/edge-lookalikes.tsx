import { useParams, useSearch } from '@modern-js/plugin-tanstack/runtime';

interface Props {
  readonly searchParams: string;
}

const buildHref = (origin: string): string => new URL('/api/customers', origin).toString();

const Page = (props: Props) => {
  const { id } = useParams({ from: '/$lang/contacts/customers/$id' });
  const search = useSearch({ from: '/$lang/contacts/customers' });
  const strict = false;
  const shape = { searchParams: props.searchParams, strict };
  return (
    <a href={buildHref('https://example.test')}>
      {id}
      {String(search)}
      {shape.searchParams}
    </a>
  );
};

export default Page;
