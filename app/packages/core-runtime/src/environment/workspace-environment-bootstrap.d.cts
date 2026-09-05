declare const bootstrapEnvironment: {
  readonly APP_ENV_PATH: string;
  readonly APP_WORKSPACE_ROOT: string;
  readonly resolveAppWorkspaceRootSync: (startDirectory: string) => string | undefined;
};

export = bootstrapEnvironment;
