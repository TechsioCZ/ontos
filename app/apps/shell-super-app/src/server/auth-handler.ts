// @effect-diagnostics asyncFunction:off
import { auth } from '@app/core-runtime/auth';
import { resolveOperationContextFromSession } from '@app/core-runtime/operation-context/session';
import { toNodeHandler } from 'better-auth/node';

export const handleShellAuthRequest = (request: Request) => auth.handler(request);
export const handleShellAuthNodeRequest = toNodeHandler(auth);

export const handleShellOperationContextRequest = async (request: Request) => {
  const resolved = await resolveOperationContextFromSession({ headers: request.headers });

  if (resolved._tag === 'Failure') {
    return Response.json(resolved.error, {
      status: 401,
    });
  }

  return Response.json({
    moduleStates: resolved.moduleStates,
    operationContext: resolved.operationContext,
  });
};
