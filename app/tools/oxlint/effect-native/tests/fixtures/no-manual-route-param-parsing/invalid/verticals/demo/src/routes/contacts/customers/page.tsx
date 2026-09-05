// expect-count: 5
import { useLoaderData, useParams } from '@modern-js/plugin-tanstack/runtime';

export interface CustomerListUrlState {
  readonly offset: number;
  readonly status: string;
}

export const parseCustomerListSearch = (search: string): CustomerListUrlState => {
  const parameters = new URLSearchParams(search);
  const statuses = parameters.getAll('status');
  const offsets = parameters.getAll('offset');
  const rawOffset = offsets.length === 1 ? offsets[0] : undefined;
  const offset =
    rawOffset === undefined || !/^(?:0|[1-9]\d*)$/u.test(rawOffset) ? 0 : Number(rawOffset);
  return { offset, status: statuses[0] ?? 'active' };
};

export const buildCustomerListHref = (language: string, currentSearch: string, offset: number) => {
  const parameters = new URLSearchParams(currentSearch);
  parameters.set('offset', String(offset));
  return `/${language}/contacts/customers?${parameters.toString()}`;
};

const CustomerListPage = () => {
  const routeParams = useParams({ strict: false });
  const model = useLoaderData({ strict: false });
  const search = new globalThis.URLSearchParams(globalThis.location.search);
  return (
    <div>
      {routeParams.id}
      {String(model)}
      {search.get('q')}
    </div>
  );
};

export default CustomerListPage;
