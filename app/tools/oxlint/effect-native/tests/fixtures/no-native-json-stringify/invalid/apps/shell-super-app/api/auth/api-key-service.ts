// expect-count: 4
// C1 evidence shape: API-key metadata, token construction, cookie construction, log annotation.
import { Effect } from "effect";

interface ApiKeyMetadata {
	readonly scopes: readonly string[];
	readonly label: string;
}

export const encodeMetadata = (metadata: ApiKeyMetadata): string => JSON.stringify(metadata);

export const encodeToken = (parts: ApiKeyMetadata): string =>
	`ctx_${Buffer.from(JSON.stringify(parts)).toString("base64url")}`;

export const attachSessionCookie = (headers: Headers, session: ApiKeyMetadata): void => {
	headers.set("set-cookie", `session=${encodeURIComponent(JSON.stringify(session))}; Path=/`);
};

export const auditIssue = (metadata: ApiKeyMetadata) =>
	Effect.logInfo("api key issued").pipe(Effect.annotateLogs({ metadata: JSON.stringify(metadata) }));
