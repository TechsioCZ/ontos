// expect-count: 2
type ChangeSource = 'session' | 'api_key' | 'system';

declare const authMethod: ChangeSource;
declare const evidence: { readonly captureMode: 'hash_only' | 'metadata_only' };

/** Tests are in scope by default: the audit's `_tag` evidence includes the test-side duplication. */
export const changeSource = (): string => {
  switch (authMethod) {
    case 'session': {
      return 'user';
    }
    case 'api_key': {
      return 'key';
    }
    case 'system': {
      return 'system';
    }
  }
};

export const captureFields = (): string => {
  switch (evidence.captureMode) {
    case 'hash_only': {
      return 'hash';
    }
    case 'metadata_only': {
      return 'metadata';
    }
  }
};
