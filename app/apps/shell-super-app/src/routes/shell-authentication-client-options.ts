import { Config, Effect } from 'effect';
import { shellAuthenticationApiContract } from '../../shared/api.ts';

export const shellAuthenticationClientOptionsFromRequest = (request: Request) =>
  Config.url('BETTER_AUTH_URL').pipe(
    Config.withDefault(new URL(request.url)),
    Effect.map((configuredOrigin) => {
      const baseUrl = new URL(shellAuthenticationApiContract.apiPrefix, configuredOrigin);
      const cookie = request.headers.get('cookie');
      return cookie === null ? { baseUrl } : { baseUrl, cookie };
    }),
  );
