import { Config, Context, Effect, Schema } from 'effect';

/** The Effect-native replacement: one Schema, decoded through Config, injected as a service. */
export const AppConfigSchema = Schema.Struct({
	databaseUrl: Schema.String,
	gatewayIssuer: Schema.String,
	poolSize: Schema.Number,
});

export type AppConfig = typeof AppConfigSchema.Type;

export class AppConfiguration extends Context.Service<AppConfiguration>()('core/AppConfiguration', {
	effect: Effect.gen(function* () {
		return yield* Config.schema(AppConfigSchema, 'ONTOS');
	}),
}) {}

/** Total string maps are fine: every key is present, nothing is optional, nothing is secret. */
export type Annotations = Readonly<Record<string, string>>;
export type Headers = Record<string, string>;

/** JSON normalisation shapes — blessed by the audit's "Existing patterns to preserve". */
export type JsonObject = Readonly<Record<string, unknown>>;
export type Counters = Record<string, number>;

/** A port, not a dictionary. */
export type EnvironmentReader = (name: string) => string | undefined;

/** A plain optional value is not an environment bag. */
export type MaybeString = string | undefined;

/** Keyed collections that are not string-dictionary literals. */
export type EnvironmentMap = ReadonlyMap<string, string>;
export type MappedOverrides = { readonly [K in 'databaseUrl' | 'gatewayIssuer']?: string };
