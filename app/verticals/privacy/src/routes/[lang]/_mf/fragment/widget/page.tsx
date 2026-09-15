import { useDistributedSsrFragmentProps } from '@modern-js/federation-runtime/distributed-ssr';
import { Widget } from '../../../../../components/widget';

const WidgetFragmentPage = () => {
  useDistributedSsrFragmentProps<Record<string, never>>({
    boundaryId: 'verticalPrivacy',
    expose: './Widget',
  });

  return (
    <>
      <template
        data-modern-boundary-id="verticalPrivacy"
        data-modern-distributed-ssr-marker="start"
        data-modern-mf-expose="./Widget"
      />
      <Widget />
      <template
        data-modern-boundary-id="verticalPrivacy"
        data-modern-distributed-ssr-marker="end"
        data-modern-mf-expose="./Widget"
      />
    </>
  );
};

export default WidgetFragmentPage;
