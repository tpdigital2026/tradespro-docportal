import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cookieOptions } from '../../../../lib/auth-cookies';
import { isDemo } from '../../../../lib/demo';
import { isSameOrigin } from '../../../../lib/same-origin';
import { DEMO_STEP_UP_CODE, demoStepUpCookieName, issueDemoStepUp } from '../../../../lib/step-up-demo';
import { STEP_UP_MAX_AGE_SECONDS } from '../../../../security/step-up';

export const dynamic = 'force-dynamic';

const body = z.discriminatedUnion('action', [z.object({ action: z.literal('request') }), z.object({ action: z.literal('verify'), code: z.string().max(20) })]);
const json = (status: number, ok: boolean, message: string) => NextResponse.json({ ok, message }, { status, headers: { 'Cache-Control': 'no-store' } });

/** DEMO MODE ONLY (404 otherwise): the stand-in for "email me a code" and "check my code" on owner-only actions. */
export async function POST(req: Request) {
  if (!isDemo()) return new NextResponse(null, { status: 404 });
  if (!isSameOrigin(req)) return json(403, false, 'Request not allowed.');
  const parsed = body.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return json(400, false, 'Please check what you entered and try again.');
  if (parsed.data.action === 'request') return json(200, true, `Demo mode: no email is sent. Use the code ${DEMO_STEP_UP_CODE}.`);
  if (parsed.data.code.trim() !== DEMO_STEP_UP_CODE) return json(401, false, 'That code did not work. Check it and try again, or ask for a new one.');
  const res = json(200, true, 'Confirmed.');
  res.cookies.set(demoStepUpCookieName(), issueDemoStepUp(Math.floor(Date.now() / 1000)), cookieOptions(STEP_UP_MAX_AGE_SECONDS));
  return res;
}
