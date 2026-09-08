import { Schema } from 'effect';
import { createFileRoute, useLoaderData, useParams, useSearch } from '@modern-js/plugin-tanstack/runtime';

export const CustomerListSearch = Schema.Struct({
  offset: Schema.Number,
  status: Schema.Literals(['active', 'archived', 'all']),
});

export const Route = createFileRoute('/$lang/contacts/customers')({
  validateSearch: Schema.standardSchemaV1(CustomerListSearch),
});

const CustomerListPage = () => {
  const { id } = useParams({ from: '/$lang/contacts/customers/$id' });
  const search = useSearch({ from: '/$lang/contacts/customers' });
  const model = useLoaderData({ from: '/$lang/contacts/customers' });
  const baseUrl = new URL('/api/contacts', globalThis.location.origin);
  const descriptor = { searchParams: search, href: baseUrl.toString() };
  return (
    <div>
      {id}
      {descriptor.searchParams.status}
      {String(model)}
    </div>
  );
};

export default CustomerListPage;
