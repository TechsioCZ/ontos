import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';

import { AgentPlatformView } from '../agent-platform/agent-platform-view.tsx';
import { PeopleView } from '../people/people-view.tsx';
import type { PeoplePageModel } from '../people/people-page-model.ts';
import { isAgentPlatformPageModel } from '../agent-platform/agent-platform-page-model.ts';
import type { AgentPlatformPageModel } from '../agent-platform/agent-platform-page-model.ts';
import type { ModuleTargetPageModel } from './modules/[moduleId]/module-page-model.ts';
import { ModuleTargetView } from './modules/[moduleId]/page.tsx';
import { ConnectionsAdminView } from './sprava/pripojene-aplikace/connections-admin-view.tsx';
import { isConnectionsAdminPageModel } from './sprava/pripojene-aplikace/connections-admin-page-model.ts';
import type { ConnectionsAdminPageModel } from './sprava/pripojene-aplikace/connections-admin-page-model.ts';

const CanonicalModulePage = () => {
  const model: ModuleTargetPageModel | AgentPlatformPageModel | ConnectionsAdminPageModel | PeoplePageModel =
    useLoaderData({
      from: '/$lang/$',
      structuralSharing: false,
    });
  if ('peoplePage' in model) {
    return <PeopleView model={model} />;
  }
  if (isConnectionsAdminPageModel(model)) {
    return <ConnectionsAdminView model={model} />;
  }
  if (isAgentPlatformPageModel(model)) {
    return <AgentPlatformView model={model} />;
  }
  return <ModuleTargetView initialModel={model} />;
};

export default CanonicalModulePage;
