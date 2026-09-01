import { loader as loadModuleTarget } from '../../modules/[moduleId]/page.data.ts';

interface ShellPageLoaderArguments {
  readonly request: Request;
}

export const loader = ({ request }: ShellPageLoaderArguments) =>
  loadModuleTarget({
    params: {
      entrypointKey: 'contacts.core.page.customers-list',
      moduleId: 'contacts.core',
    },
    request,
  });
