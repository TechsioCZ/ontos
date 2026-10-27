import { Context } from 'effect';

/** Correlation of the command whose committed clients are being reconciled. */
export class PartyIntakeCorrelation extends Context.Service<PartyIntakeCorrelation, string>()(
  '@app/crm/services/party-intake-correlation/PartyIntakeCorrelation',
) {}
