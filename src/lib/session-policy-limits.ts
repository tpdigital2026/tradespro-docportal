/** The session policy's ranges and defaults (see session-policy.ts). Pure, with no Node imports, so screens can use it. */
export const IDLE_MINUTES = { min: 10, max: 480, default: 30 } as const;
export const MAX_SESSION_DAYS = { min: 1, max: 30, default: 7 } as const;

export interface SessionLimits {
  idleMinutes: number;
  maxDays: number;
}
export const DEFAULT_LIMITS: SessionLimits = { idleMinutes: IDLE_MINUTES.default, maxDays: MAX_SESSION_DAYS.default };

export const inRange = (n: unknown, r: { min: number; max: number }): n is number => typeof n === 'number' && Number.isInteger(n) && n >= r.min && n <= r.max;

/** Limits from a database row (or anything); each value falls back to its default when missing or out of range. */
export function limitsFrom(row: unknown): SessionLimits {
  const r = (row && typeof row === 'object' ? row : {}) as { idle_logout_minutes?: unknown; max_session_days?: unknown };
  return {
    idleMinutes: inRange(r.idle_logout_minutes, IDLE_MINUTES) ? r.idle_logout_minutes : IDLE_MINUTES.default,
    maxDays: inRange(r.max_session_days, MAX_SESSION_DAYS) ? r.max_session_days : MAX_SESSION_DAYS.default,
  };
}
