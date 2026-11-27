// expect-count: 5
// Other form models: a form library, a validation library, effect-form around the form module, React form status, FormData.
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormReact } from '@lucas-barake/effect-form-react';
import { useFormStatus } from 'react-dom';

export const schema = z.object({ name: z.string() });
export const useLibraries = () => [useForm(), FormReact, useFormStatus(), new FormData()];
