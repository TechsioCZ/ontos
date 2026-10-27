import { Context } from 'effect';

/** Company from the verified gateway assertion for the current intake request. */
export class PartyIntakeCompany extends Context.Service<
  PartyIntakeCompany,
  {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
  }
>()('@app/crm/services/party-intake-company/PartyIntakeCompany') {}
