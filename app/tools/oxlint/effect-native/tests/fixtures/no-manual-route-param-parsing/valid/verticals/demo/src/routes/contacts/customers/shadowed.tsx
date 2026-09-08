import { FormData as UndiciFormData } from 'undici';

class URLSearchParams {
  constructor(readonly raw: string) {}
  get(_key: string): string {
    return this.raw;
  }
}

const useParams = (_options: { readonly strict: boolean }) => ({ id: 'local' });

const renderWithLocalHelpers = (URL: (value: string) => { searchParams: string }) => {
  const parsed = new URLSearchParams('offset=1');
  const params = useParams({ strict: false });
  const url = URL('/x');
  const body = new UndiciFormData();
  return `${parsed.get('offset')}${params.id}${url.searchParams}${String(body)}`;
};

const Page = () => <span>{renderWithLocalHelpers(() => ({ searchParams: 'none' }))}</span>;

export default Page;
