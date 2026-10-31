import { Schema } from 'effect';
import { GatewayAudienceSchema } from './gateway-context.ts';

/** Transport credentials only; these are never business payload or Action hash inputs. */
export const ReferenceGatewayCredentialsSchema = Schema.Array(
  Schema.Struct({
    audience: GatewayAudienceSchema,
    authorization: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000))),
  }),
).check(Schema.isMaxLength(16));

export const REFERENCE_GATEWAY_CREDENTIALS_HEADER = 'x-ontos-reference-credentials';
