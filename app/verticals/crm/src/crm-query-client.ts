import { QueryClient } from '@tanstack/react-query';

const createCrmQueryClient = () =>
  new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });

let browserQueryClient: QueryClient | undefined;
const contactEditSuccesses = new WeakMap<QueryClient, Set<string>>();

const contactEditSuccessKey = (customerId: string, contactId: string) =>
  `${customerId}:${contactId}`;

export const getCrmQueryClient = () => {
  if (globalThis.window === undefined) {
    return createCrmQueryClient();
  }
  browserQueryClient ??= createCrmQueryClient();
  return browserQueryClient;
};

export const markContactEditSuccess = (
  queryClient: QueryClient,
  customerId: string,
  contactId: string,
) => {
  const successes = contactEditSuccesses.get(queryClient) ?? new Set<string>();
  successes.add(contactEditSuccessKey(customerId, contactId));
  contactEditSuccesses.set(queryClient, successes);
};

export const hasContactEditSuccess = (
  queryClient: QueryClient,
  customerId: string,
  contactId: string,
) =>
  contactEditSuccesses.get(queryClient)?.has(contactEditSuccessKey(customerId, contactId)) === true;

export const consumeContactEditSuccess = (
  queryClient: QueryClient,
  customerId: string,
  contactId: string,
) =>
  contactEditSuccesses.get(queryClient)?.delete(contactEditSuccessKey(customerId, contactId)) ===
  true;
