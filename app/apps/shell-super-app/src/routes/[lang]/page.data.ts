import { currentSession, runEffectRequest } from '../../api/auth-client.ts';
import { shellAuthenticationApiContract } from '../../../shared/api.ts';
import type { CurrentSession } from '../../../shared/api.ts';

interface HomeLoaderArguments {
  readonly request: Request;
}

const anonymousSession: CurrentSession = {
  state: 'anonymous',
};

export const loader = ({ request }: HomeLoaderArguments): Promise<CurrentSession> => {
  const cookie = request.headers.get('cookie');

  return runEffectRequest(
    currentSession({
      baseUrl: new URL(shellAuthenticationApiContract.apiPrefix, request.url),
      ...(cookie === null ? {} : { cookie }),
    }),
  ).catch(() => anonymousSession);
};
