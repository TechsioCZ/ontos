import { Schema } from 'effect';
import { CounterpartyAccessContractViolation } from './counterparty-access-contract-violation.ts';
import { CounterpartyAccessUnavailable } from './counterparty-access-unavailable.ts';

export { CounterpartyAccessContractViolation } from './counterparty-access-contract-violation.ts';
export { CounterpartyAccessUnavailable } from './counterparty-access-unavailable.ts';

export const CounterpartyAccessDomainErrorSchema = Schema.Union([
  CounterpartyAccessContractViolation,
  CounterpartyAccessUnavailable,
]);
export type CounterpartyAccessDomainError = typeof CounterpartyAccessDomainErrorSchema.Type;
