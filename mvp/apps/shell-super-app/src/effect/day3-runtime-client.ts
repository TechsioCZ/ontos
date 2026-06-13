// @effect-diagnostics asyncFunction:off globalFetch:off
import { day3ShellApiContract } from '@mvp/shared-effect-api';
import type {
  DemoUserKey,
  ProtectedResourceReadRequest,
  RuntimeContext,
} from '@mvp/shared-effect-api';

interface SignInDemoUserResponse {
  readonly context: RuntimeContext;
  readonly didWriteRuntimeRows: false;
  readonly signedIn: true;
}

interface SignOutDemoUserResponse {
  readonly didWriteRuntimeRows: false;
  readonly signedIn: false;
}

interface CurrentRuntimeContextResponse {
  readonly context: RuntimeContext;
  readonly didWriteRuntimeRows: false;
}

export interface ProtectedResourceReadDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly resourceId: string;
  readonly stage: string;
  readonly userId: string;
}

interface ProtectedResourceReadResponse {
  readonly decision: ProtectedResourceReadDecision;
  readonly didWriteRuntimeRows: false;
}

const requestJson = async <TResponse>(
  path: string,
  init: {
    body?: unknown;
    method: 'GET' | 'POST';
  },
): Promise<TResponse> => {
  const requestInit: RequestInit = {
    credentials: 'same-origin',
    method: init.method,
  };

  if (init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
    requestInit.headers = { 'content-type': 'application/json' };
  }

  const response = await fetch(`${day3ShellApiContract.apiPrefix}${path}`, requestInit);

  if (!response.ok) {
    throw new Error(`Day 3 runtime request failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as TResponse;
};

export const getCurrentRuntimeContext = () =>
  requestJson<CurrentRuntimeContextResponse>('/effect/day3/runtime-context', {
    method: 'GET',
  });

export const signInDemoUser = (demoUserKey: DemoUserKey) =>
  requestJson<SignInDemoUserResponse>('/effect/day3/sign-in-demo-user', {
    body: { demoUserKey },
    method: 'POST',
  });

export const signOutDemoUser = () =>
  requestJson<SignOutDemoUserResponse>('/effect/day3/sign-out-demo-user', {
    body: {},
    method: 'POST',
  });

export const checkProtectedResourceRead = (request: ProtectedResourceReadRequest) =>
  requestJson<ProtectedResourceReadResponse>('/effect/day3/check-protected-resource-read', {
    body: request,
    method: 'POST',
  });
