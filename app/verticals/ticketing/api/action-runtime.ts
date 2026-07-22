// @effect-diagnostics asyncFunction:off
import { coreSDKErrorHttpStatus, runAction, runDataAccess } from '@app/core-runtime';
import type {
  ActionRegistration,
  CoreSDKError,
  DataAccessRegistration,
  OperationResult,
} from '@app/core-runtime';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type CoreSdkOperationTransportOutcome<TResponse> =
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
      readonly state?: JsonValue;
    };

const errorCode = (error: CoreSDKError): string | undefined =>
  'code' in error ? error.code : undefined;

const toJsonValue = (value: unknown): JsonValue => structuredClone(value) as JsonValue;

const errorState = (error: CoreSDKError): JsonValue | undefined =>
  'state' in error ? toJsonValue(error.state) : undefined;

const toCoreSdkTransportOutcome = <TPayload, TResponse>(
  result: OperationResult<TPayload, TResponse>,
): CoreSdkOperationTransportOutcome<TResponse> => {
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
  const state = errorState(result);

  return {
    ...(code === undefined ? {} : { code }),
    errorTag: result._tag,
    httpStatus: coreSDKErrorHttpStatus(result),
    message: result.message,
    ok: false,
    ...(state === undefined ? {} : { state }),
  };
};

export const runCoreSdkAction = async <TAction, TResponse>({
  headers,
  payload,
  registration,
}: {
  readonly headers: Headers;
  readonly payload: TAction;
  readonly registration: ActionRegistration<TAction, TResponse>;
}): Promise<CoreSdkOperationTransportOutcome<TResponse>> => {
  const result = await runAction({ payload, registration, transport: { headers } });
  return toCoreSdkTransportOutcome(result);
};

export const runCoreSdkDataAccess = async <TPayload, TResponse>({
  headers,
  payload,
  registration,
  resultCount,
}: {
  readonly headers: Headers;
  readonly payload: TPayload;
  readonly registration: DataAccessRegistration<TPayload, TResponse>;
  readonly resultCount: (response: TResponse) => number;
}): Promise<CoreSdkOperationTransportOutcome<TResponse>> => {
  const result = await runDataAccess({
    payload,
    registration,
    resultCount,
    transport: { headers },
  });
  return toCoreSdkTransportOutcome(result);
};
