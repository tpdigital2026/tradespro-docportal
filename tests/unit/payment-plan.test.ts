import { describe, expect, it } from 'vitest';
import {
  MAX_STAGES,
  PlanError,
  buildSchedule,
  checkPlan,
  computeTotals,
  depositOf,
  formatPct,
  mulDivRound,
  type Instalment,
  type PaymentPlan,
  type PlanStage,
  type Totals,
} from '../../src/lib/money';

/** Totals for a single priced line, optionally with VAT at the given rate. */
function totalsOf(netPence: number, vat: boolean, rateBp = 2000): Totals {
  return computeTotals([{ description: 'Work', kind: 'work', qty: 1, unitNetPence: netPence, vatApplies: vat }], rateBp);
}

function sums(list: Instalment[]) {
  return {
    net: list.reduce((s, i) => s + i.netPence, 0),
    vat: list.reduce((s, i) => s + i.vatPence, 0),
    gross: list.reduce((s, i) => s + i.grossPence, 0),
  };
}

function expectExact(t: Totals, list: Instalment[]) {
  expect(sums(list)).toEqual({ net: t.netPence, vat: t.vatPence, gross: t.grossPence });
  list.forEach((i, k) => {
    expect(i.index).toBe(k + 1);
    expect(i.netPence + i.vatPence).toBe(i.grossPence);
    expect(Number.isSafeInteger(i.grossPence)).toBe(true);
    expect(i.netPence).toBeGreaterThanOrEqual(0);
    expect(i.vatPence).toBeGreaterThanOrEqual(0);
    expect(i.grossPence).toBeGreaterThan(0);
  });
}

const pct = (label: string, pctBp: number): PlanStage => ({ label, mode: 'pct', pctBp });
const amt = (label: string, grossPence: number): PlanStage => ({ label, mode: 'amount', grossPence });
const bpOf = (s: PlanStage) => (s.mode === 'pct' ? s.pctBp : 0);

const ODD_TOTALS: Totals[] = [
  totalsOf(100_000, true),
  totalsOf(100_001, true),
  totalsOf(33_333, true),
  totalsOf(1_001, true),
  totalsOf(99_999, true, 500),
  totalsOf(123_457, false),
  totalsOf(3_000_000, true),
  totalsOf(50_000, true, 1234),
  totalsOf(100_000_000, true),
];

describe('formatPct', () => {
  it('shows whole, half and two-decimal percentages without floats', () => {
    expect(formatPct(3000)).toBe('30');
    expect(formatPct(3050)).toBe('30.5');
    expect(formatPct(3333)).toBe('33.33');
    expect(formatPct(100)).toBe('1');
    expect(formatPct(9900)).toBe('99');
    expect(formatPct(5)).toBe('0.05');
  });
});

describe('mulDivRound overflow guard', () => {
  it('refuses a product that cannot be held exactly', () => {
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, 5000, 10000)).toThrow(RangeError);
  });
});

describe('pay in full', () => {
  it('is one instalment for the whole job', () => {
    for (const t of ODD_TOTALS) {
      const s = buildSchedule(t, { kind: 'full' });
      expect(s).toEqual([{ index: 1, label: 'Invoice', netPence: t.netPence, vatPence: t.vatPence, grossPence: t.grossPence }]);
    }
  });
  it('is refused for a job worth nothing', () => {
    expect(() => buildSchedule(totalsOf(0, true), { kind: 'full' })).toThrow(PlanError);
  });
});

describe('deposit plan', () => {
  it('uses the existing depositOf semantics and takes the balance by subtraction, for every half percent from 1 to 99', () => {
    let count = 0;
    for (const t of ODD_TOTALS) {
      for (let bp = 100; bp <= 9900; bp += 50) {
        const s = buildSchedule(t, { kind: 'deposit', pctBp: bp });
        const d = depositOf(t, bp);
        expect(s).toHaveLength(2);
        expect([s[0].netPence, s[0].vatPence, s[0].grossPence]).toEqual([d.netPence, d.vatPence, d.grossPence]);
        expect(s[1].netPence).toBe(t.netPence - d.netPence);
        expect(s[1].vatPence).toBe(t.vatPence - d.vatPence);
        expect(s[1].grossPence).toBe(t.grossPence - d.grossPence);
        expectExact(t, s);
        count++;
      }
    }
    expect(count).toBe(ODD_TOTALS.length * 197);
  });
  it('labels the deposit with its percentage and the rest as the balance', () => {
    const t = totalsOf(100_000, true);
    expect(buildSchedule(t, { kind: 'deposit', pctBp: 3000 }).map((i) => i.label)).toEqual(['Deposit (30%)', 'Balance']);
    expect(buildSchedule(t, { kind: 'deposit', pctBp: 3250 }).map((i) => i.label)).toEqual(['Deposit (32.5%)', 'Balance']);
  });
  it('rounds half away from zero on an odd penny', () => {
    const t = totalsOf(1_001, true);
    const s = buildSchedule(t, { kind: 'deposit', pctBp: 3000 });
    expect(s[0].netPence).toBe(300); // 300.3
    expect(s[0].vatPence).toBe(60); // vat 200, 60.0
    const tiny = totalsOf(50, false);
    expect(buildSchedule(tiny, { kind: 'deposit', pctBp: 100 })[0].netPence).toBe(1); // 0.5 rounds up
  });
  it('rejects 0%, 100%, anything outside 1 to 99, off-step values and non-integers', () => {
    const t = totalsOf(100_000, true);
    for (const bp of [0, 50, 99, 9950, 10_000, 10_050, -100, 125, 3001, 30.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildSchedule(t, { kind: 'deposit', pctBp: bp }), String(bp)).toThrow(PlanError);
    }
  });
  it('rejects a deposit or balance that would be nothing', () => {
    expect(() => buildSchedule(totalsOf(40, false), { kind: 'deposit', pctBp: 100 })).toThrow(/nothing/);
    expect(() => buildSchedule(totalsOf(1, false), { kind: 'deposit', pctBp: 9900 })).toThrow(PlanError);
  });
});

describe('staged plan by percentage', () => {
  it('splits into 2 to 10 stages that always sum exactly, with the last stage by subtraction', () => {
    for (const t of ODD_TOTALS) {
      for (let n = 2; n <= MAX_STAGES; n++) {
        const base = Math.floor(10_000 / n);
        const stages = Array.from({ length: n }, (_, i) => pct(`Stage ${i + 1}`, i === n - 1 ? 10_000 - base * (n - 1) : base));
        const s = buildSchedule(t, { kind: 'staged', stages });
        expect(s).toHaveLength(n);
        expectExact(t, s);
        expect(s.map((i) => i.label)).toEqual(stages.map((x) => x.label));
        const head = s.slice(0, n - 1);
        expect(s[n - 1].grossPence).toBe(t.grossPence - head.reduce((a, b) => a + b.grossPence, 0));
      }
    }
  });
  it('uses mulDivRound per net and per VAT for the earlier stages', () => {
    const t = totalsOf(100_001, true);
    const s = buildSchedule(t, { kind: 'staged', stages: [pct('A', 3333), pct('B', 3333), pct('C', 3334)] });
    expect(s[0].netPence).toBe(mulDivRound(t.netPence, 3333, 10_000));
    expect(s[0].vatPence).toBe(mulDivRound(t.vatPence, 3333, 10_000));
    expect(s[1].netPence).toBe(mulDivRound(t.netPence, 3333, 10_000));
    expectExact(t, s);
  });
  it('a 30,000 pound job in 5 payments', () => {
    const t = totalsOf(2_500_000, true); // 25,000 net + 5,000 VAT
    expect(t.grossPence).toBe(3_000_000);
    const s = buildSchedule(t, {
      kind: 'staged',
      stages: [pct('Deposit', 2000), pct('Scaffold up and strip complete', 2000), pct('Roof structure complete', 2500), pct('Roof covering complete', 2000), pct('Handover', 1500)],
    });
    expect(s.map((i) => i.grossPence)).toEqual([600_000, 600_000, 750_000, 600_000, 450_000]);
    expectExact(t, s);
  });
  it('allows two-decimal percentages', () => {
    const t = totalsOf(100_000, true);
    expectExact(t, buildSchedule(t, { kind: 'staged', stages: [pct('A', 3333), pct('B', 6667)] }));
  });
  it('rejects 0% and 100% on any stage', () => {
    const t = totalsOf(100_000, true);
    expect(() => buildSchedule(t, { kind: 'staged', stages: [pct('A', 0), pct('B', 10_000)] })).toThrow(PlanError);
    expect(() => buildSchedule(t, { kind: 'staged', stages: [pct('A', 10_000), pct('B', 0)] })).toThrow(PlanError);
    expect(() => buildSchedule(t, { kind: 'staged', stages: [pct('A', 5000), pct('B', 5000), pct('C', 0)] })).toThrow(PlanError);
  });
  it('rejects a total that is not exactly 100%, naming the gap', () => {
    const t = totalsOf(100_000, true);
    const under = checkPlan(t, { kind: 'staged', stages: [pct('A', 3000), pct('B', 3000), pct('C', 3000)] });
    expect(under.ok).toBe(false);
    expect(under.problems.map((p) => p.message).join(' ')).toMatch(/90%.*10%.*still to place/);
    expect(under.remainingPence).toBe(12_000);
    const over = checkPlan(t, { kind: 'staged', stages: [pct('A', 6000), pct('B', 5000)] });
    expect(over.ok).toBe(false);
    expect(over.problems.map((p) => p.message).join(' ')).toMatch(/110%.*10%.*too much/);
    expect(over.remainingPence).toBe(-12_000);
  });
  it('is exact to a single basis point', () => {
    const t = totalsOf(100_000, true);
    expect(checkPlan(t, { kind: 'staged', stages: [pct('A', 4999), pct('B', 5000)] }).ok).toBe(false);
    expect(checkPlan(t, { kind: 'staged', stages: [pct('A', 5001), pct('B', 5000)] }).ok).toBe(false);
    expect(checkPlan(t, { kind: 'staged', stages: [pct('A', 5000), pct('B', 5000)] }).ok).toBe(true);
  });
});

describe('staged plan by fixed amount', () => {
  it('splits a fixed gross amount using the job VAT share and sums exactly', () => {
    const t = totalsOf(2_500_000, true);
    const s = buildSchedule(t, { kind: 'staged', stages: [amt('Deposit', 900_000), amt('Middle', 1_100_000), amt('Handover', 1_000_000)] });
    expect(s[0].vatPence).toBe(150_000); // one sixth of a 20% VAT gross
    expect(s[0].netPence).toBe(750_000);
    expectExact(t, s);
  });
  it('rounds the VAT part of an odd amount half away from zero', () => {
    const t = totalsOf(100_000, true); // gross 120000, vat 20000 (one sixth)
    expect(buildSchedule(t, { kind: 'staged', stages: [amt('A', 5), amt('B', 119_995)] })[0]).toMatchObject({ vatPence: 1, netPence: 4 }); // 0.83
    expect(buildSchedule(t, { kind: 'staged', stages: [amt('A', 3), amt('B', 119_997)] })[0]).toMatchObject({ vatPence: 1, netPence: 2 }); // 0.5
    expect(buildSchedule(t, { kind: 'staged', stages: [amt('A', 2), amt('B', 119_998)] })[0]).toMatchObject({ vatPence: 0, netPence: 2 }); // 0.33
  });
  it('a no-VAT job has no VAT in any stage', () => {
    const t = totalsOf(123_457, false);
    const s = buildSchedule(t, { kind: 'staged', stages: [amt('A', 100_000), amt('B', 23_457)] });
    expect(s.every((i) => i.vatPence === 0)).toBe(true);
    expectExact(t, s);
  });
  it('rejects amounts that do not total the job gross, and over-allocation', () => {
    const t = totalsOf(100_000, true); // 120000
    expect(checkPlan(t, { kind: 'staged', stages: [amt('A', 50_000), amt('B', 69_999)] }).ok).toBe(false);
    expect(checkPlan(t, { kind: 'staged', stages: [amt('A', 50_000), amt('B', 70_001)] }).ok).toBe(false);
    expect(checkPlan(t, { kind: 'staged', stages: [amt('A', 50_000), amt('B', 70_000)] }).ok).toBe(true);
    const under = checkPlan(t, { kind: 'staged', stages: [amt('A', 50_000), amt('B', 60_000)] });
    expect(under.problems.map((p) => p.message).join(' ')).toMatch(/£100\.00 of the job unplaced/);
    const over = checkPlan(t, { kind: 'staged', stages: [amt('A', 80_000), amt('B', 50_000)] });
    expect(over.problems.map((p) => p.message).join(' ')).toMatch(/£100\.00 over/);
    expect(() => buildSchedule(t, { kind: 'staged', stages: [amt('A', 70_000), amt('B', 60_000), amt('C', 10_000)] })).toThrow(PlanError);
  });
  it('rejects zero, negative, fractional and whole-job amounts', () => {
    const t = totalsOf(100_000, true);
    for (const g of [0, -5, 1.5, 120_000, 999_999]) {
      expect(() => buildSchedule(t, { kind: 'staged', stages: [amt('A', g), amt('B', 1)] }), String(g)).toThrow(PlanError);
    }
  });
  it('a mix of percentages and amounts works when it adds up', () => {
    const t = totalsOf(100_000, true); // 120000
    const s = buildSchedule(t, { kind: 'staged', stages: [pct('A', 2500), amt('B', 40_000), amt('C', 55_000 - 5_000)] });
    expect(s.map((i) => i.grossPence)).toEqual([30_000, 40_000, 50_000]);
    expectExact(t, s);
    expect(checkPlan(t, { kind: 'staged', stages: [pct('A', 2500), amt('B', 40_000), amt('C', 49_999)] }).ok).toBe(false);
  });
});

describe('staged plan structure', () => {
  const t = totalsOf(100_000, true);
  it('needs 2 to 10 stages', () => {
    expect(() => buildSchedule(t, { kind: 'staged', stages: [pct('A', 9999)] })).toThrow(PlanError);
    expect(() => buildSchedule(t, { kind: 'staged', stages: [] })).toThrow(PlanError);
    const eleven = Array.from({ length: 11 }, (_, i) => pct(`S${i}`, i === 10 ? 910 : 909));
    expect(eleven.reduce((s, x) => s + bpOf(x), 0)).toBe(10_000);
    expect(() => buildSchedule(t, { kind: 'staged', stages: eleven })).toThrow(/between 2 and 10/);
  });
  it('every stage needs a name of reasonable length', () => {
    expect(() => buildSchedule(t, { kind: 'staged', stages: [pct('', 5000), pct('B', 5000)] })).toThrow(PlanError);
    expect(() => buildSchedule(t, { kind: 'staged', stages: [pct('   ', 5000), pct('B', 5000)] })).toThrow(PlanError);
    expect(() => buildSchedule(t, { kind: 'staged', stages: [pct('x'.repeat(81), 5000), pct('B', 5000)] })).toThrow(PlanError);
    expect(buildSchedule(t, { kind: 'staged', stages: [pct('  Roof on  ', 5000), pct('B', 5000)] })[0].label).toBe('Roof on');
  });
  it('points each problem at its stage', () => {
    const c = checkPlan(t, { kind: 'staged', stages: [pct('A', 0), pct('B', 5000), amt('C', 0)] });
    expect(c.problems.filter((p) => p.stage !== null).map((p) => p.stage)).toEqual([0, 2]);
  });
  it('shows what each stage works out at while the plan is incomplete', () => {
    const c = checkPlan(t, { kind: 'staged', stages: [pct('A', 2500), amt('B', 40_000)] });
    expect(c.declaredPerStage).toEqual([30_000, 40_000]);
    expect(c.declaredPence).toBe(70_000);
    expect(c.remainingPence).toBe(50_000);
    expect(c.ok).toBe(false);
  });
  it('refuses a job with no value', () => {
    expect(() => buildSchedule(totalsOf(0, true), { kind: 'staged', stages: [pct('A', 5000), pct('B', 5000)] })).toThrow(PlanError);
  });
});

describe('property: the schedule always sums to the job exactly', () => {
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it('holds for 3000 random jobs and plans of every kind', () => {
    const r = rng(20261014);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    let built = 0;
    let refused = 0;
    for (let k = 0; k < 3000; k++) {
      const t = totalsOf(int(100, 100_000_000), r() < 0.8, [0, 500, 2000, 1234][int(0, 3)]);
      let plan: PaymentPlan;
      const which = int(0, 3);
      if (which === 0) plan = { kind: 'full' };
      else if (which === 1) plan = { kind: 'deposit', pctBp: 50 * int(2, 198) };
      else {
        const n = int(2, MAX_STAGES);
        const cuts = new Set<number>();
        const top = which === 2 ? 9999 : t.grossPence - 1;
        while (cuts.size < n - 1) cuts.add(int(1, top));
        const end = which === 2 ? 10_000 : t.grossPence;
        const pts = [0, ...[...cuts].sort((x, y) => x - y), end];
        plan = { kind: 'staged', stages: pts.slice(1).map((p, i) => (which === 2 ? pct : amt)(`S${i + 1}`, p - pts[i])) };
      }
      let s: Instalment[] | null = null;
      try {
        s = buildSchedule(t, plan);
      } catch (e) {
        expect(e).toBeInstanceOf(PlanError); // only ever a clear refusal, never a wrong answer
        refused++;
      }
      if (s) {
        built++;
        expect(sums(s)).toEqual({ net: t.netPence, vat: t.vatPence, gross: t.grossPence });
        s.forEach((i) => {
          expect(i.netPence + i.vatPence).toBe(i.grossPence);
          expect(i.grossPence).toBeGreaterThan(0);
          expect(i.netPence).toBeGreaterThanOrEqual(0);
          expect(i.vatPence).toBeGreaterThanOrEqual(0);
        });
      }
    }
    expect(built).toBeGreaterThan(2000);
    expect(built + refused).toBe(3000);
  });
  it('percentage stages totalling 100% on a real-sized job are never refused', () => {
    const r = rng(7);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (let k = 0; k < 500; k++) {
      const t = totalsOf(int(100_000, 100_000_000), true);
      const n = int(2, MAX_STAGES);
      const cuts = new Set<number>();
      while (cuts.size < n - 1) cuts.add(int(100, 9900));
      const pts = [0, ...[...cuts].sort((x, y) => x - y), 10_000];
      const stages = pts.slice(1).map((p, i) => pct(`S${i + 1}`, p - pts[i]));
      expectExact(t, buildSchedule(t, { kind: 'staged', stages }));
    }
  });
});
