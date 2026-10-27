// Frozen first-party boundary from scripts/ontos-mcp-contribution.mts.
import { Array as EffectArray, Effect, Order, Schema } from 'effect';

class OntosMcpContributionDerivationError extends Schema.TaggedError<OntosMcpContributionDerivationError>()(
  'OntosMcpContributionDerivationError', { message: Schema.String },
) {}

const ActionValueSchema = Schema.Struct({
  descriptor: Schema.Struct({
    actionKey: Schema.String.pipe(Schema.brand('OntosMcpActionKey')),
    payloadSchema: Schema.optionalKey(Schema.Unknown),
  }),
});
interface ActionEndpoint { readonly slug: string }
declare const slugOrder: Order.Order<ActionEndpoint>;
declare const actionEndpointOf: (
  action: typeof ActionValueSchema.Type,
  context: { readonly appId: string; readonly moduleId: string },
) => Effect.Effect<ActionEndpoint>;

export const actionEndpointsOf = (actions: readonly unknown[], moduleId: string, appId: string) =>
  Effect.forEach((rawAction: unknown) =>
    Schema.decodeUnknownEffect(ActionValueSchema)(rawAction).pipe(
      Effect.mapError(
        () => new OntosMcpContributionDerivationError({ message: 'manifest Actions must be Action registrations' }),
      ),
      Effect.flatMap((action) => actionEndpointOf(action, { appId, moduleId })),
    ),
  )(actions).pipe(Effect.map((endpoints) => EffectArray.sort(endpoints, slugOrder)));

const decodeAction = Schema.decodeUnknownEffect(ActionValueSchema);
export const actionViaNativeAlias = (rawAction: unknown) => decodeAction(rawAction);
