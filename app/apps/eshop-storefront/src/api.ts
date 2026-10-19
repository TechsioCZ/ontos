import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiProblem } from './shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ApiProblem;
  constructor(status: number, problem: ApiProblem) {
    super(problem.message);
    this.status = status;
    this.problem = problem;
  }
}

export const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError(0, { code: 'network', message: 'Nepodařilo se spojit se serverem e-shopu. Zkontrolujte připojení a zkuste to znovu.' });
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const problem = (body as ApiProblem | undefined) ?? { code: 'http_error', message: `Server odpověděl chybou ${response.status}.` };
    throw new ApiError(response.status, problem);
  }
  return body as T;
};

export interface AsyncState<T> {
  readonly data: T | undefined;
  readonly error: ApiError | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
}

/** Fetches `path` whenever it changes; `reload` refetches. Stale responses are ignored. */
export const useApi = <T,>(path: string | null): AsyncState<T> => {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: path !== null });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    if (path === null) return;
    const ticket = ++latest.current;
    setState((previous) => ({ data: previous.data, loading: true }));
    request<T>(path)
      .then((data) => {
        if (ticket === latest.current) setState({ data, loading: false });
      })
      .catch((error: unknown) => {
        if (ticket === latest.current) setState({ error: error instanceof ApiError ? error : new ApiError(0, { code: 'unknown', message: String(error) }), loading: false });
      });
  }, [path, nonce]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
};
