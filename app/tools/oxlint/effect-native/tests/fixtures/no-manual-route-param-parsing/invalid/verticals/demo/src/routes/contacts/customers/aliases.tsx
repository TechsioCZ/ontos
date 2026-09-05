// expect-count: 3
import { useParams as useRouteParams } from '@modern-js/plugin-tanstack/runtime';
import * as Router from '@modern-js/plugin-tanstack/runtime';

const DetailPage = () => {
  const params = useRouteParams({ strict: false });
  const search = Router.useSearch({ strict: false });
  const data = Router.useLoaderData({ select: (value: unknown) => value, 'strict': false });
  return (
    <span>
      {params.id}
      {String(search)}
      {String(data)}
    </span>
  );
};

export default DetailPage;
