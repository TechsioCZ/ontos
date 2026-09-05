import { useParams } from '@modern-js/plugin-tanstack/runtime';

const Page = () => {
  const params = useParams({ strict: false });
  const parsed = new URLSearchParams('offset=0');
  const form = new FormData();
  return (
    <span>
      {String(params)}
      {parsed.get('offset')}
      {String(form)}
    </span>
  );
};

export default Page;
