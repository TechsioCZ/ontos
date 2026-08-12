import { loadModuleTargetPageModel } from '../modules/[moduleId]/page.data.ts';
import { CRM_MODULE_ID } from '../../../../shared/module-routes.ts';

interface CrmModuleTargetLoaderArguments {
  readonly request: Request;
}

export const loader = ({ request }: CrmModuleTargetLoaderArguments) =>
  loadModuleTargetPageModel({ params: { moduleId: CRM_MODULE_ID }, request });
