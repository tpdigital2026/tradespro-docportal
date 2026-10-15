import { NextResponse } from 'next/server';
import { moneyCsv, moneyView, parseMoneyParams } from '../../../../lib/business/money-view';
import { getBusinessFacts } from '../../../../lib/data/business';
import { todayLondon } from '../../../../lib/london';
import { getSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * The rows the Money screen is showing, as CSV. The business comes from the session (never the URL); the filter and
 * month are read with the same rules as the screen. Every cell is made safe for spreadsheets (src/lib/business/csv.ts).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 });
  const today = todayLondon();
  const params = parseMoneyParams(new URL(req.url).searchParams, today);
  let csv: { filename: string; body: string };
  try {
    csv = moneyCsv(moneyView((await getBusinessFacts()).jobs, params, today));
  } catch {
    return NextResponse.json({ ok: false, message: 'The spreadsheet could not be made just now. Please try again.' }, { status: 500 });
  }
  return new Response(csv.body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csv.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
