import { Config, Option, Schema } from 'effect';

/**
 * What one deployment of the shared runtime serves, independent of `ULTRAMODERN_DEPLOYMENT_ENVIRONMENT`: several
 * deployments run the same stage feature set, but only the canonical demo owns the AKROS demo fixture records.
 */

/**
 * Opt-in, default off: the canonical demo discovers its existing AKROS customer source before migrations and replays
 * its Symmy demo authorities after them. A fresh deployment has none of those records, so it never reads or writes them.
 */
export const DEMO_FIXTURES_ENABLED_VARIABLE = 'ONTOS_DEMO_FIXTURES_ENABLED';
/** The public origin of this deployment's N1 storefront; unset admits no N1 origin to the Commerce Portal realm. */
export const N1_STOREFRONT_ORIGIN_VARIABLE = 'ONTOS_N1_STOREFRONT_ORIGIN';

export const PublicOriginSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'https:' && url.pathname === '/' && url.search === '' && url.hash === '' && url.username === ''
      ? undefined
      : 'the public origins must be bare HTTPS origins',
  ),
);

export const demoFixturesEnabled = Config.Boolean(DEMO_FIXTURES_ENABLED_VARIABLE).pipe(Config.withDefault(false));

export const n1StorefrontOrigin = Config.schema(PublicOriginSchema, N1_STOREFRONT_ORIGIN_VARIABLE).pipe(
  Config.option,
  Config.map(Option.map((url) => url.origin)),
);
