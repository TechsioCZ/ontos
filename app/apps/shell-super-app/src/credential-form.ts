import type { SubmitEvent } from 'react';

/** Keep browser-native submission POST-only; the typed client handles submissions only after hydration. */
export const submitCredentialForm = (
  event: SubmitEvent<HTMLFormElement>,
  hydrated: boolean,
  submit: (data: FormData) => void,
  password?: HTMLInputElement | null,
) => {
  event.preventDefault();
  if (!hydrated) {
    return;
  }
  submit(new FormData(event.currentTarget));
  if (password !== undefined && password !== null) {
    password.value = '';
  }
};
