import { createTicketActorValid } from './create-ticket-actor-valid.ts';
import type { PolicyCheck } from '@app/core-runtime';
import type { CreateTicketActionPayload } from '../../shared/actions/create-ticket.ts';

export const ticketingPolicies: {
  readonly createTicketActorValid: PolicyCheck<CreateTicketActionPayload>;
} = {
  createTicketActorValid,
};
