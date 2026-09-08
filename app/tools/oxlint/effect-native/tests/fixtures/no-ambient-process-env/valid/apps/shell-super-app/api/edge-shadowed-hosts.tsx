// Injected or shadowed hosts are the *target* shape: nothing here touches the real environment.
export interface Ports {
	readonly process: { readonly env: Record<string, string> };
	readonly Deno: { readonly env: { readonly get: (key: string) => string | undefined } };
}

export const fromPort = ({ process, Deno }: Ports) => `${process.env["A"]}:${Deno.env.get("B") ?? ""}`;

export const withLocals = () => {
	const process = { env: { A: "1" } };
	const Bun = { env: { B: "2" } };
	return `${process.env.A}${Bun.env.B}`;
};

export const Panel = ({ env }: { readonly env: Record<string, string> }) => <span>{env["TENANT"]}</span>;

export class Runtime {
	constructor(private readonly ports: Ports) {}
	get url(): string {
		return this.ports.process.env["URL"] ?? "";
	}
}
