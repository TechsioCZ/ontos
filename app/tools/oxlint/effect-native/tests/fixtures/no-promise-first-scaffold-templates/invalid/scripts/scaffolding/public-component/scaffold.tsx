// expect-count: 4
/** A8/A9: the component generator emits Promise-first plumbing instead of Effect data hooks. */
export const renderComponent = (name: string): string => `import * as React from 'react';

export const ${name} = () => {
  const [state, setState] = React.useState('idle');

  const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

  const submit = React.useCallback(async (payload: unknown) => {
    const result = await Effect.runPromise(submitPayload(payload));
    setState(result.status);
  }, []);

  return <button onClick={() => { void delay(); void submit({}); }}>{state}</button>;
};
`;
