import { Helmet } from '@modern-js/runtime/head';
import type { ReactElement } from 'react';

/** Party Registry currently publishes governed APIs and no owner-rendered route. */
export const UltramodernRouteHead = (): ReactElement => (
  <Helmet>
    <title>Party Registry</title>
    <meta content="Governed Party Registry API" name="description" />
    <meta content="noindex, nofollow" name="robots" />
  </Helmet>
);
