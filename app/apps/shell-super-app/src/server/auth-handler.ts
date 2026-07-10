// @effect-diagnostics asyncFunction:off
import { auth } from '@app/core-runtime/auth';
import { createVerticalGatewayToken } from '@app/core-runtime';
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

  const verticalGatewayTokens = Object.fromEntries(
    resolved.moduleStates.map((moduleState) => [
      moduleState.moduleKey,
      createVerticalGatewayToken({
        audience: moduleState.moduleKey,
        operationContext: resolved.operationContext,
      }),
    ]),
  );

  return Response.json({
    moduleStates: resolved.moduleStates,
    operationContext: resolved.operationContext,
    verticalGatewayTokens,
  });
};
