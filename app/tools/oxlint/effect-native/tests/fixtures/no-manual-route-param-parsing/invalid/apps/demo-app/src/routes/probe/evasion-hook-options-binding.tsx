// expect-count: 1
import { useParams } from '@modern-js/plugin-tanstack/runtime';

const untyped = { strict: false } as const;

const Page = () => {
  const params = useParams(untyped);
  return <span>{String(params)}</span>;
};

export default Page;
