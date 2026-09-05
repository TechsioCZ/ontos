// expect-count: 4
import process from "node:process";

const configurationError = (): Error => new Error("bootstrap configuration is invalid");

function readUrl(): URL {
	const raw = process.env["ONTOS_DATABASE_URL"];
	if (raw === undefined) throw configurationError();
	try {
		return new URL(raw);
	} catch (cause) {
		throw cause;
	}
}

export async function bootstrap(): Promise<void> {
	const url = readUrl();
	if (url.protocol !== "postgres:") {
		throw new Error(`unsupported protocol ${url.protocol}`);
	}
	await Promise.resolve();
	if (url.username.length === 0) throw new TypeError("missing role");
}
