import { createAuthClient } from 'better-auth/react';

type AuthClient = ReturnType<typeof createAuthClient>;

export const authClient: AuthClient = createAuthClient({
  basePath: '/shell-super-app-api/auth',
});
