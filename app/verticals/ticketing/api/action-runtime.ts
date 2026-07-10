// @effect-diagnostics asyncFunction:off
import { coreSDKErrorHttpStatus, runAction } from '@app/core-runtime';
import type { ActionRegistration, CoreSDKError } from '@app/core-runtime';

export type CoreSdkActionTransportOutcome<TResponse> =
  | {
      readonly actionInvocationId?: string;
      readonly ok: true;
      readonly response: TResponse;
    }
  | {
      readonly code?: string;
      readonly errorTag: CoreSDKError['_tag'];
      readonly httpStatus: number;
      readonly message: string;
      readonly ok: false;
    };

const errorCode = (error: CoreSDKError): string | undefined =>
  'code' in error ? error.code : undefined;

export const runCoreSdkAction = async <TAction, TResponse>({
  headers,
  payload,
  registration,
}: {
  readonly headers: Headers;
  readonly payload: TAction;
  readonly registration: ActionRegistration<TAction, TResponse>;
}): Promise<CoreSdkActionTransportOutcome<TResponse>> => {
  const result = await runAction({
    payload,
    registration,
    transport: {
      headers,
    },
  });

  if (result._tag === 'OperationSucceeded') {
    return {
      ...(result.context.actionInvocation?.actionInvocationId === undefined
        ? {}
        : { actionInvocationId: result.context.actionInvocation.actionInvocationId }),
      ok: true,
      response: result.response,
    };
  }

  const code = errorCode(result);

  return {
    ...(code === undefined ? {} : { code }),
    errorTag: result._tag,
    httpStatus: coreSDKErrorHttpStatus(result),
    message: result.message,
    ok: false,
  };
};
