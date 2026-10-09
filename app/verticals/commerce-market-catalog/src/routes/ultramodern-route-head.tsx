import { Helmet } from '@modern-js/runtime/head';
import type { ReactElement } from 'react';

/** Market Catalog currently publishes governed contracts and no public indexable route. */
export const UltramodernRouteHead = (): ReactElement => (
  <Helmet>
    <title>Commerce Market Catalog</title>
    <meta content="Governed Commerce Market Catalog" name="description" />
    <meta content="noindex, nofollow" name="robots" />
  </Helmet>
);
