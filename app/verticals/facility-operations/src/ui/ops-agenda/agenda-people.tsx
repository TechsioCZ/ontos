import { createContext, useContext } from 'react';
import type { agendaPeople } from './model.ts';

/** Only session identity and names carried by the permission-filtered agenda records. */
export const AgendaPeopleContext = createContext<ReturnType<typeof agendaPeople>>([]);
export const useAgendaPeople = () => useContext(AgendaPeopleContext);
