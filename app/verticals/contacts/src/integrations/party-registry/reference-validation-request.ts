import { Context } from 'effect';

export interface PartyRegistryReferenceRequestOptions {
  readonly cookie?: string;
  readonly correlationId: string;
}

export class PartyRegistryReferenceRequest extends Context.Service<
  PartyRegistryReferenceRequest,
  PartyRegistryReferenceRequestOptions
>()(
  '@app/contacts/integrations/party-registry/reference-validation-request/PartyRegistryReferenceRequest',
) {}
