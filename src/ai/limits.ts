import { createRateLimiter } from './rate-limit';

/** Ten tidy-ups per person in ten minutes. Server only. */
export const scopeCopyLimiter = createRateLimiter(10, 10 * 60_000);
