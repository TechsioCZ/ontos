// expect-count: 4
// B3 evidence shape: a migration script that decides the process outcome from three helpers.

const requireArgument = (name: string): string => {
	const value = process.env[name];
	if (value === undefined) {
		console.error(`missing ${name}`);
		process.exit(1);
	}
	return value;
};

async function apply(tenant: string): Promise<void> {
	if (tenant.length > 64) {
		globalThis.process.exit(3);
	}
	await Promise.resolve(tenant);
}

export async function migrate(): Promise<void> {
	const tenant = requireArgument("TENANT");
	if (tenant === "") {
		process.exitCode = 2;
		return;
	}
	try {
		await apply(tenant);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
