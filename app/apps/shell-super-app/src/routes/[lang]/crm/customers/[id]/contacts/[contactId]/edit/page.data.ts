import {
  loader as loadModuleTarget,
  selectRouteParams,
} from '../../../../../../modules/[moduleId]/page.data.ts';

interface ShellPageLoaderArguments {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly request: Request;
}

const routeParameterNames = ['id', 'contactId'] as const;

export const loader = ({ params, request }: ShellPageLoaderArguments) =>
  loadModuleTarget({
    params: {
      entrypointKey: 'crm.core.page.contact-edit',
      moduleId: 'crm.core',
    },
    request,
    routeParams: selectRouteParams(params, routeParameterNames),
  });
