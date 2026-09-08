// expect-count: 2
import { useParams, useSearch } from '@modern-js/plugin-tanstack/runtime';

const untyped = { strict: false };
const strict = false;

const Page = () => {
  const params = useParams({ ...untyped });
  const search = useSearch({ strict });
  return (
    <span>
      {String(params)}
      {String(search)}
    </span>
  );
};

export default Page;
