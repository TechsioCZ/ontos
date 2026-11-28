import { Button } from '@techsio/ui-kit/atoms/button';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { useState } from 'react';

import { clientColumns } from './columns.ts';

export const Page = () => [Button, DataTable, Link, Effect, useState, clientColumns];
