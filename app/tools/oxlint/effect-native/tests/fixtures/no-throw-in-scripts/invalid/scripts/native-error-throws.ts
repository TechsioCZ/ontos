// expect-count: 6
interface ModuleContract {
	readonly moduleId: string;
}

export function assertJsonObject(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new Error(`${label} must be a JSON object`);
	}
	if (Array.isArray(value)) {
		throw new TypeError(`${label} must not be an array`);
	}
	return value as Record<string, unknown>;
}

export function assertPort(raw: string): number {
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port)) throw new SyntaxError("port must be an integer");
	if (port < 1 || port > 65_535) throw new RangeError("port out of range");
	return port;
}

export function readContract(value: unknown): ModuleContract {
	const record = assertJsonObject(value, "contract");
	const moduleId = record["moduleId"];
	if (typeof moduleId !== "string") {
		throw new ReferenceError("contract.moduleId is missing");
	}
	if (moduleId.length === 0) {
		throw new AggregateError([], "contract.moduleId is empty");
	}
	return { moduleId };
}
