/** Promises, standards, accreditations and marketing words. The AI may not introduce one the owner did not write. Data only. */
export const CLAIM_WORDS: readonly string[] = [
  'guarantee', 'guaranteed', 'guaranteeing', 'warranty', 'warranted', 'lifetime', 'certified', 'accredited', 'approved', 'compliant',
  'compliance', 'regulation', 'british', 'standard', 'bs', 'en', 'nhbc', 'insured', 'insurance', 'free', 'premium', 'durable',
  'lasting', 'quality', 'best', 'superior', 'weathertight', 'watertight', 'leakproof', 'proof', 'maintenance', 'excellent', 'finest',
  'leading', 'trusted', 'reliable', 'unbeatable', 'cheap', 'affordable', 'discount', 'guarantees',
  // round two
  'waterproof', 'weatherproof', 'certificate', 'certify', 'certification', 'accreditation', 'accredit', 'registered', 'register', 'registration',
  'kitemark', 'lifelong', 'lifespan', 'quarterly', 'warrantee', 'assured', 'assurance', 'gassafe', 'longterm', 'fensa', 'regs', 'forever', 'permanent', 'permanently', 'professional', 'professionally', 'expert', 'expertise', 'expertly',
];

/** Several words that make a claim together. Matched as whole consecutive words (plural stripped), any case, hyphens as spaces. */
export const CLAIM_PHRASES: readonly string[] = ['long term', 'kite mark', 'gas safe', 'no leaks', 'never leak', 'weather tight', 'life time', 'water tight'];
