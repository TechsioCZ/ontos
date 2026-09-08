// expect-count: 3
interface RouteEnvironment {
	readonly [key: string]: string | undefined;
}

type FederationOverrides = Readonly<Partial<Record<string, string>>>;

type NullableEnvironment = Record<string, string | null>;

export const EnvironmentPanel = ({
	environment,
	overrides,
	nullable,
}: {
	readonly environment: RouteEnvironment;
	readonly overrides: FederationOverrides;
	readonly nullable: NullableEnvironment;
}) => (
	<dl>
		{Object.entries(environment).map(([key, value]) => (
			<div key={key}>
				{key}: {value ?? overrides[key] ?? nullable[key] ?? ''}
			</div>
		))}
	</dl>
);
