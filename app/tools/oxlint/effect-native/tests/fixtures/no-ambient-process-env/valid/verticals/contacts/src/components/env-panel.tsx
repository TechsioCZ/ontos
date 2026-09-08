// Injected configuration and locally shadowed bindings must never report.
interface PanelProps {
	readonly environment: Readonly<Record<string, string | undefined>>;
}

export function EnvironmentPanel({ environment }: PanelProps) {
	return <span data-api={environment.PUBLIC_API_URL}>{environment["MODE"]}</span>;
}

export function ShadowedProcess() {
	const process = { env: { PUBLIC_API_URL: "https://example.test" } };
	return <span>{process.env.PUBLIC_API_URL}</span>;
}

export function LocalEnvBag() {
	const fake = { env: { MODE: "test" } };
	const { env } = fake;
	return <span>{env.MODE}</span>;
}
