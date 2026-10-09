import { useDistributedSsrFragmentProps } from '@modern-js/federation-runtime/distributed-ssr';
import type { ComponentProps } from 'react';

import Widget from '../../../../../components/inventory-widget';

const WidgetFragmentPage = () => {
  const props = useDistributedSsrFragmentProps<ComponentProps<typeof Widget>>({
    boundaryId: 'verticalInventory',
    expose: './Widget',
  });

  return (
    <>
      <template
        data-modern-boundary-id="verticalInventory"
        data-modern-distributed-ssr-marker="start"
        data-modern-mf-expose="./Widget"
      />
      <Widget {...props} />
      <template
        data-modern-boundary-id="verticalInventory"
        data-modern-distributed-ssr-marker="end"
        data-modern-mf-expose="./Widget"
      />
    </>
  );
};

export default WidgetFragmentPage;
