import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';

import { AgentPlatformView } from '../agent-platform/agent-platform-view.tsx';
import {
  type AgentPlatformPageModel,
  isAgentPlatformPageModel,
} from '../agent-platform/agent-platform-page-model.ts';
import type { ModuleTargetPageModel } from './modules/[moduleId]/module-page-model.ts';
import { ModuleTargetView } from './modules/[moduleId]/page.tsx';

const CanonicalModulePage = () => {
  const model: ModuleTargetPageModel | AgentPlatformPageModel = useLoaderData({
    from: '/$lang/$',
    structuralSharing: false,
  });
  if (isAgentPlatformPageModel(model)) {
    return <AgentPlatformView model={model} />;
  }
  return <ModuleTargetView initialModel={model} />;
};

export default CanonicalModulePage;
