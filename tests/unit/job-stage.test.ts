import { describe, expect, it } from 'vitest';
import { STAGES, byUrgency, newDocumentHref, nextStep, stageIndex } from '../../src/lib/job-stage';

describe('job stage', () => {
  it('orders the six stages', () => {
    expect(STAGES).toHaveLength(6);
    expect(stageIndex('quoted')).toBe(0);
    expect(stageIndex('guarantee-issued')).toBe(5);
  });

  it('gives the next document for each stage', () => {
    expect(nextStep('quoted')).toEqual({ label: 'Raise deposit invoice', type: 'deposit-invoice' });
    expect(nextStep('deposit-invoiced')).toEqual({ label: 'Record deposit receipt', type: 'receipt' });
    expect(nextStep('deposit-paid')).toEqual({ label: 'Raise balance invoice', type: 'balance-invoice' });
    expect(nextStep('balance-invoiced')).toEqual({ label: 'Issue receipt, paid in full', type: 'receipt' });
    expect(nextStep('paid-in-full')).toEqual({ label: 'Issue guarantee certificate', type: 'guarantee' });
  });

  it('has no next step once the guarantee is issued', () => {
    expect(nextStep('guarantee-issued')).toBeNull();
  });

  it('builds a real route string', () => {
    expect(newDocumentHref('receipt', 'DEMO-1001')).toBe('/documents/new?type=receipt&job=DEMO-1001');
    expect(newDocumentHref('quotation')).toBe('/documents/new?type=quotation');
  });

  it('drops finished jobs and puts the earliest stage first', () => {
    const out = byUrgency([
      { id: 'a', stage: 'paid-in-full' as const },
      { id: 'b', stage: 'guarantee-issued' as const },
      { id: 'c', stage: 'quoted' as const },
    ]);
    expect(out.map((j) => j.id)).toEqual(['c', 'a']);
  });
});
