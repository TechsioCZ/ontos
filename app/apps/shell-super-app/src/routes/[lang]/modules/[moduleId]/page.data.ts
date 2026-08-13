/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader preserves the typed Effect error channel until the framework boundary. */
import { Effect } from 'effect';
import type { ResolvedModuleTarget } from '../../../../../shared/api.ts';
import { resolveModuleTarget, runEffectRequest } from '../../../../api/auth-client.ts';
import type { ShellTargetClientError } from '../../../../api/auth-client.ts';
import { shellAuthenticationApiContract } from '../../../../../shared/api.ts';
import { loadHomePageModel } from '../../page.data.ts';
import type { HomePageModel } from '../../page.data.ts';

interface ModuleTargetLoaderArguments {
  readonly params: { readonly entrypointKey?: string; readonly moduleId: string };
  readonly request: Request;
}

export type ModuleTargetPageModel =
  | {
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'selection_required' | 'unavailable';
    }
  | {
      readonly shell: HomePageModel;
      readonly state: 'resolved';
      readonly target: ResolvedModuleTarget;
    };

const safeState = (error: ShellTargetClientError, shell: HomePageModel): ModuleTargetPageModel => {
  switch (error._tag) {
    case 'ShellAuthenticationRequiredProblem':
    case 'ShellSelectionRequiredProblem': {
      return { shell, state: 'selection_required' };
    }
    case 'ShellTargetForbiddenProblem': {
      return { shell, state: 'forbidden' };
    }
    case 'ShellTargetNotFoundProblem': {
      return { shell, state: 'not_found' };
    }
    case 'ShellCapabilityUnavailableProblem':
    case 'ShellInternalProblem': {
      return { shell, state: 'unavailable' };
    }
    default: {
      return { shell, state: 'unavailable' };
    }
  }
};

export const loader = async ({ params, request }: ModuleTargetLoaderArguments) => {
  const shell = await loadHomePageModel(request);
  if (shell.state !== 'authenticated') {
    return {
      shell,
      state: shell.state === 'unavailable' ? 'unavailable' : 'selection_required',
    } as const;
  }
  const cookie = request.headers.get('cookie');
  const options = {
    baseUrl: new URL(shellAuthenticationApiContract.apiPrefix, request.url),
    ...(cookie === null ? {} : { cookie }),
  };
  return runEffectRequest(
    resolveModuleTarget(
      {
        ...(params.entrypointKey === undefined ? {} : { entrypointKey: params.entrypointKey }),
        moduleId: params.moduleId,
      },
      options,
    ).pipe(
      Effect.map((target): ModuleTargetPageModel => ({ shell, state: 'resolved', target })),
      Effect.catch((error) => Effect.succeed(safeState(error, shell))),
    ),
  );
};
