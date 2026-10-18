import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
  makeEffectHttpApiClient,
} from '@modern-js/bff-effect/effect-client';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const ModuleIdSchema = Schema.String.pipe(Schema.brand('ModuleId'));
const NavigationApi = HttpApi.make('AgreementsShellNavigationApi').add(
  HttpApiGroup.make('composition').add(
    HttpApiEndpoint.get('shellComposition', '/shell/composition', {
      success: Schema.Struct({
        navigation: Schema.Array(Schema.Struct({ moduleId: ModuleIdSchema })),
        state: Schema.String,
      }),
    }),
  ),
);

/** Narrow optional rental reads; owner authorization remains authoritative for every request. */
export const rentalReferencesReadable = ({
  navigation,
  state,
}: {
  readonly navigation: readonly { readonly moduleId: string }[];
  readonly state: string;
}) =>
  state === 'available' &&
  ['siampark.property', 'siampark.occupancy'].every((moduleId) =>
    navigation.some((item) => item.moduleId === moduleId),
  );

const lookup = makeEffectHttpApiClient(NavigationApi, { baseUrl: '/shell-super-app-api' }).pipe(
  Effect.flatMap((client) => client.composition.shellComposition({})),
  Effect.map(rentalReferencesReadable),
  Effect.timeout('3 seconds'),
  Effect.orElseSucceed(() => false),
);

// Legal entity switches reload the document, so this cache cannot outlive its selected scope.
export const rentalReferenceAccess = browserRuntime.runSync(Effect.cached(lookup));
