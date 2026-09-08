// expect-count: 3
type ShellTargetClientError = {
  readonly _tag: 'ShellTargetForbiddenProblem' | 'ShellAuthenticationRequiredProblem';
};
type ShellModel = { readonly state: string };

// Axis 3: `switch (error._tag)` in a loader-local helper.
const safeState = (error: ShellTargetClientError, shell: ShellModel): ShellModel => {
  switch (error._tag) {
    case 'ShellAuthenticationRequiredProblem': {
      return { state: 'selection_required' };
    }
    case 'ShellTargetForbiddenProblem': {
      return { state: 'forbidden' };
    }
    default: {
      return shell;
    }
  }
};

// Axis 3: parameter named for the failure, annotation is a bare alias.
const tenantSwitchFailureState = (problem: ShellTargetClientError) =>
  problem._tag === 'ShellAuthenticationRequiredProblem' ? 'authentication-required' : 'failed';

// Axis 3: object member holding the classifier, `error.reason._tag` chain.
export const handlers = {
  onFailure: function onFailure(error: { readonly reason: ShellTargetClientError }) {
    return error.reason._tag === 'ShellTargetForbiddenProblem' ? 'forbidden' : 'failed';
  },
};

export const loader = () => ({ handlers, safeState, tenantSwitchFailureState });
