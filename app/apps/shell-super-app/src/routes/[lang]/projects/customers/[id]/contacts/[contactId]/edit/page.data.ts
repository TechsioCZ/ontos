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
      entrypointKey: 'projects.core.page.contact-edit',
      moduleId: 'projects.core',
    },
    request,
    routeParams: selectRouteParams(params, routeParameterNames),
  });
