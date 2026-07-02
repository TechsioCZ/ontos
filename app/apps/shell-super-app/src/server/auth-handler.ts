import { auth } from '@app/core-runtime/auth';
import { toNodeHandler } from 'better-auth/node';

export const handleShellAuthRequest = (request: Request) => auth.handler(request);
export const handleShellAuthNodeRequest = toNodeHandler(auth);
