// expect-count: 3
import { useLoaderData, useParams, useSearch } from '@modern-js/plugin-tanstack/runtime';

interface UntypedOptions {
  readonly strict: boolean;
}

const Page = () => {
  const params = useParams({ strict: false } as const);
  const search = useSearch?.({ strict: false } satisfies UntypedOptions);
  const data = useLoaderData!({ strict: false });
  return (
    <span>
      {String(params)}
      {String(search)}
      {String(data)}
    </span>
  );
};

export default Page;
