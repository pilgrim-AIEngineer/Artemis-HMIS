'use client';

import type { MasterKind } from '@hmis/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTRPCClient } from '@/trpc/client';

/**
 * The masters screens are one generic list/dialog driven by `definitions.tsx`, so they reach the
 * typed `masters.*` procedures by name. The cast is confined to this file; procedure names are
 * checked by `masters-ui.test.ts` against the router.
 */
export type ProcNames = Record<'list' | 'create' | 'update' | 'cancel' | 'restore', string>;

const procs = (singular: string, plural: string): ProcNames => ({
  list: `list${plural}`,
  create: `create${singular}`,
  update: `update${singular}`,
  cancel: `cancel${singular}`,
  restore: `restore${singular}`,
});

export const MASTER_PROCS: Record<MasterKind, ProcNames> = {
  departments: procs('Department', 'Departments'),
  doctors: procs('Doctor', 'Doctors'),
  services: procs('Service', 'Services'),
  tariffs: procs('Tariff', 'Tariffs'),
  payers: procs('Payer', 'Payers'),
  drugs: procs('Drug', 'Drugs'),
  'lab-tests': procs('LabTest', 'LabTests'),
  'usg-procedures': procs('UsgProcedure', 'UsgProcedures'),
  'reason-codes': procs('ReasonCode', 'ReasonCodes'),
};

export type Row = Record<string, unknown> & { id: string; status: string };

export interface ListPage {
  rows: Row[];
  nextCursor: string | null;
  truncated: boolean;
}

type Proc = { query(input?: unknown): Promise<unknown>; mutate(input?: unknown): Promise<unknown> };

/** Calls `trpc.masters.<name>` (query or mutation). */
export function useMastersCall() {
  const client = useTRPCClient();
  return useCallback(
    (name: string, kind: 'query' | 'mutate', input?: unknown): Promise<unknown> => {
      const proc = (client.masters as unknown as Record<string, Proc>)[name];
      if (!proc) throw new Error(`masters.${name} does not exist`);
      return proc[kind](input);
    },
    [client],
  );
}

export interface ListParams {
  search: string;
  includeCancelled: boolean;
  filters: Record<string, string>;
}

export function useMasterList(kind: MasterKind, params: ListParams) {
  const call = useMastersCall();
  const { search, includeCancelled, filters } = params;
  return useInfiniteQuery({
    queryKey: ['masters', kind, 'list', search, includeCancelled, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      call(MASTER_PROCS[kind].list, 'query', {
        search: search || undefined,
        includeCancelled,
        limit: 50,
        cursor: pageParam,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')),
      }) as Promise<ListPage>,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Small active lists for the select fields of the forms. */
export type LookupName = 'departments' | 'payers' | 'users' | 'labTests' | 'usgProcedures';

export interface LookupItem {
  value: string;
  label: string;
}

const LOOKUP_PROC: Record<LookupName, string> = {
  departments: 'listDepartments',
  payers: 'listPayers',
  users: 'listUserOptions',
  labTests: 'listLabTests',
  usgProcedures: 'listUsgProcedures',
};

export function useLookup(name: LookupName | undefined, enabled = true) {
  const call = useMastersCall();
  return useQuery({
    queryKey: ['masters', 'lookup', name],
    enabled: enabled && !!name,
    staleTime: 30_000,
    queryFn: async (): Promise<LookupItem[]> => {
      const res = await call(
        LOOKUP_PROC[name!],
        'query',
        name === 'users' ? undefined : { limit: 200 },
      );
      if (name === 'users') {
        return (res as { id: string; fullName: string; username: string }[]).map((u) => ({
          value: u.id,
          label: `${u.fullName} (${u.username})`,
        }));
      }
      return (res as ListPage).rows.map((r) => ({
        value: r.id,
        label:
          name === 'labTests' || name === 'usgProcedures'
            ? `${String(r.code)} · ${String(r.name)}`
            : String(r.name),
      }));
    },
  });
}

export function useMasterMutation(kind: MasterKind, action: keyof ProcNames) {
  const call = useMastersCall();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: unknown) => call(MASTER_PROCS[kind][action], 'mutate', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['masters'] }),
  });
}

/** A cell/field value as display text; objects and nulls become an empty string. */
export function cellText(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}
