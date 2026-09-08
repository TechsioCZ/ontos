// expect-count: 4
import { useMutation, useQuery } from '@tanstack/react-query';
import { Effect as EffectRuntime, Random } from 'effect';
import { archiveCustomer, getCustomerList, runEffectRequest } from '../contacts-api.ts';

const createCorrelationId = () =>
  EffectRuntime.runSync(Random.nextIntBetween(0, 9)).toString(36);

export const CustomersPage = () => {
  const query = useQuery({
    queryFn: () => runEffectRequest(getCustomerList({ correlationId: createCorrelationId() })),
    queryKey: ['customers'],
  });
  const lifecycle = useMutation({
    mutationFn: (customerId: string) =>
      runEffectRequest(archiveCustomer({ correlationId: createCorrelationId(), customerId })),
  });
  const handleRefresh = () => {
    void runEffectRequest(getCustomerList({ correlationId: createCorrelationId() }));
  };
  return (
    <button onClick={handleRefresh} type="button">
      {String(query.isPending || lifecycle.isPending)}
    </button>
  );
};
