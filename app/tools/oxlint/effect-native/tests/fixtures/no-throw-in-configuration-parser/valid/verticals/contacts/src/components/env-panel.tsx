// Aliased and submodule Effect imports must still count as Effect callbacks, including `.pipe(...)`.
import { Effect as E } from 'effect';
import * as Sch from 'effect/Schema';

export const PanelConfig = Sch.Struct({ locale: Sch.String });

export const loadPanel = (environment: Readonly<Record<string, string | undefined>>) =>
  E.try({
    catch: () => new Error('panel configuration is malformed'),
    try: () => {
      const locale = environment['ONTOS_LOCALE'];
      if (locale === undefined) {
        throw new Error('ONTOS_LOCALE is required');
      }
      return Sch.decodeUnknownSync(PanelConfig)({ locale });
    },
  });

export const decodeLocale = (environment: Readonly<Record<string, string | undefined>>) =>
  E.succeed(environment['ONTOS_LOCALE']).pipe(
    E.map((locale) => {
      if (locale === undefined) {
        throw new Error('ONTOS_LOCALE is required');
      }
      return locale;
    }),
  );

export const EnvPanel = () => <section>{'panel'}</section>;
