// expect-count: 2
// `[K in string]` is not a closed key set — it is `Record<string, …>` spelled as a mapped type.
export type MappedEnvironment = { readonly [K in string]: string | undefined };

export type PartialMappedEnvironment = { [K in string]?: string };

export const EnvironmentBadge = ({ environment }: { readonly environment: MappedEnvironment }) => (
	<span>{environment['ONTOS_GATEWAY_ISSUER'] ?? ''}</span>
);
