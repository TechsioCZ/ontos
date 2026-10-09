import { useDistributedSsrFragmentProps } from '@modern-js/federation-runtime/distributed-ssr';
import type { ComponentProps } from 'react';

import Widget from '../../../../../components/catalog-widget';

const WidgetFragmentPage = () => {
  const props = useDistributedSsrFragmentProps<ComponentProps<typeof Widget>>({
    boundaryId: 'verticalCatalog',
    expose: './Widget',
  });

  return (
    <>
      <template
        data-modern-boundary-id="verticalCatalog"
        data-modern-distributed-ssr-marker="start"
        data-modern-mf-expose="./Widget"
      />
      <Widget {...props} />
      <template
        data-modern-boundary-id="verticalCatalog"
        data-modern-distributed-ssr-marker="end"
        data-modern-mf-expose="./Widget"
      />
    </>
  );
};

export default WidgetFragmentPage;
