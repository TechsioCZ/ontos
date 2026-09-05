// expect-count: 6
export interface PrincipalRecord {
	readonly principalId: string;
}

export interface ApiKeyBindingRecord {
	readonly authBindingId: string;
}

/** Audit A2 evidence shape: `principal-management.ts:61`. */
export interface PrincipalManagementRepositoryService {
	readonly createPrincipal: (input: { readonly tenantId: string }) => Promise<
		{ readonly principalId: string } | undefined
	>;
	readonly loadPrincipal: (tenantId: string, principalId: string) => Promise<PrincipalRecord | undefined>;
	readonly loadApiKeyBinding: (authBindingId: string) => Promise<ApiKeyBindingRecord | undefined>;
	loadSupportBinding(authBindingId: string): Promise<PrincipalRecord | null>;
	readonly listPrincipals: (tenantId: string) => Promise<readonly PrincipalRecord[]>;
	readonly onMissing?: (reason: string) => void;
}

export const loadPrincipal = async (tenantId: string): Promise<PrincipalRecord | undefined> => {
	void tenantId;
	return undefined;
};

export async function loadApiKeyBinding(authBindingId: string): Promise<ApiKeyBindingRecord | null> {
	void authBindingId;
	return null;
}
