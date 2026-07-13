// @effect-diagnostics globalConsole:off
import { allowPolicy, denyPolicy, rejectAction } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
  PolicyCheck,
} from '@app/core-runtime';
import {
  createTicketActionKey,
  createTicketActionPayloadSchema,
  createTicketActionResponseSchema,
} from '../../shared/actions/create-ticket';
import type {
  CreateTicketActionPayload,
  CreateTicketActionResponse,
} from '../../shared/actions/create-ticket';

const nonEmptyTargetResourcePolicyKey = 'ticketing.createTicket.targetResourceId.present';

const createTicketDomainEvent = {
  eventType: 'ticketing.createTicket.accepted',
  payload: (input) => ({
    summary: input.summary,
    targetResourceId: input.targetResourceId,
  }),
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.targetResourceId,
  subjectResourceType: 'createTicket',
} satisfies ActionDomainEventDescriptor<CreateTicketActionPayload, CreateTicketActionResponse>;

const createTicketActionHandler: ActionHandler<
  CreateTicketActionPayload,
  CreateTicketActionResponse
> = (input, services) => {
  const targetResourceId = input.targetResourceId.trim();
  if (targetResourceId.length === 0) {
    throw rejectAction({
      code: 'ticketing.createTicket.target_resource_required',
      message: 'Create Ticket requires a targetResourceId.',
    });
  }

  console.log('Create Action Called');

  services.context.addOutboxMessage?.({
    payload: {
      actionInvocationId: services.context.actionInvocation?.actionInvocationId,
      actionKey: createTicketActionKey,
      targetResourceId,
    },
    topic: 'ticketing.createTicket.created',
  });

  return {
    accepted: true,
    actionKey: createTicketActionKey,
    message: 'Create Ticket accepted by CoreSDK.',
    targetResourceId,
  };
};

const createTicketPolicyChecks: readonly PolicyCheck<CreateTicketActionPayload>[] = [
  ({ data }) =>
    data.targetResourceId.trim().length > 0
      ? allowPolicy({
          policyKey: nonEmptyTargetResourcePolicyKey,
          reason: 'The action targets a concrete resource.',
        })
      : denyPolicy({
          code: 'ticketing.createTicket.target_resource_required',
          message: 'Create Ticket requires a targetResourceId.',
          policyKey: nonEmptyTargetResourcePolicyKey,
          reason: 'Create Ticket requires a non-empty targetResourceId.',
          state: {
            targetResourceId: data.targetResourceId,
          },
        }),
];

export const createTicketActionRegistration: ActionRegistration<
  CreateTicketActionPayload,
  CreateTicketActionResponse
> = {
  descriptor: {
    actionKey: createTicketActionKey,
    auditProfile: 'standard',
    authorization: {
      permission: 'create',
      provider: 'spicedb',
      resourceObjectId: 'ticketing.createTicket',
      resourceObjectType: 'resource_type',
    },
    domainEvent: createTicketDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: createTicketActionPayloadSchema,
    transportResponseSchema: createTicketActionResponseSchema,
  },
  handler: createTicketActionHandler,
  policyChecks: createTicketPolicyChecks,
};
