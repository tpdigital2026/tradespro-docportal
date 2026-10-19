/**
 * Demo mode only: the guarantee certificates made in this demo session, kept in memory (on globalThis, so pages, server
 * actions and routes see the same list). Dummy data; never used outside demo mode. Kept in its own small file so the
 * Pipeline and Guarantees demo facts can read it without importing the data layer.
 */
import { demoSlot } from './demo';
import type { GuaranteeValues } from './guarantee/model';

export interface DemoGuarantee {
  id: string;
  jobId: string;
  customerId: string;
  number: string;
  status: 'draft' | 'final';
  values: GuaranteeValues;
  createdAt: string;
  /** yyyy-mm-dd the draft was last saved on (a draft is issued on the day it is finalised). */
  docDate: string;
  /** ISO timestamp, once final. */
  finalisedAt: string | null;
}

const box = demoSlot<{ rows: DemoGuarantee[] }>('guarantees', () => ({ rows: [] }));

export const demoGuaranteeRows = (): DemoGuarantee[] => box.get().rows;

/** Test hook: forget demo guarantees. */
export function resetDemoGuarantees(): void {
  box.set(null);
}

/** Demo mode: a certificate is finalised (issued on the given London date). */
export function demoGuaranteeMarkFinal(id: string, today: string): void {
  const r = box.get().rows.find((x) => x.id === id);
  if (r) {
    r.status = 'final';
    r.docDate = today;
    r.finalisedAt = new Date().toISOString();
  }
}
