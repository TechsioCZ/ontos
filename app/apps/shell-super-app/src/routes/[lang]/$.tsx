import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';

import type { ModuleTargetPageModel } from './modules/[moduleId]/module-page-model.ts';
import { ModuleTargetView } from './modules/[moduleId]/page.tsx';

const CanonicalModulePage = () => {
  const initialModel: ModuleTargetPageModel = useLoaderData({
    from: '/$lang/$',
    structuralSharing: false,
  });
  return <ModuleTargetView initialModel={initialModel} />;
};

export default CanonicalModulePage;
