/**
 * A clearly dummy survey report (Mr John Smith, 123 Bromley Road) with drawn placeholder photos. No real customer,
 * address, finding or photo from any reference document is used here.
 */
import sharp from 'sharp';
import type { SurveyInput } from '../../src/templates/survey';

const SCENES: [string, string, string][] = [
  ['#9fb7cc', '#5b4a3d', '#3c3f45'],
  ['#c7d3dd', '#7a5b45', '#2f3338'],
  ['#8aa4bb', '#6d6d6d', '#4a3b30'],
  ['#b5c4cf', '#4f5a63', '#7b6a58'],
  ['#a9bccb', '#8a6a52', '#383c40'],
  ['#d0d9e0', '#555b60', '#6b5444'],
];

/** A drawn stand-in for a site photo: sky, a roof slope with courses, a gutter line and a label. */
export async function placeholderPhoto(i: number, w = 1600, h = 1200): Promise<Buffer> {
  const [sky, roof, wall] = SCENES[i % SCENES.length];
  const courses = Array.from({ length: 14 }, (_, k) => `<line x1="0" y1="${h * 0.3 + k * h * 0.035}" x2="${w}" y2="${h * 0.22 + k * h * 0.035}" stroke="#00000022" stroke-width="${Math.max(2, w / 400)}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="#eef2f5"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
    <polygon points="0,${h * 0.3} ${w},${h * 0.18} ${w},${h * 0.78} 0,${h * 0.8}" fill="${roof}"/>
    ${courses}
    <rect x="0" y="${h * 0.78}" width="${w}" height="${h * 0.04}" fill="#dcdcdc"/>
    <rect x="0" y="${h * 0.82}" width="${w}" height="${h * 0.18}" fill="${wall}"/>
    <circle cx="${w * (0.25 + (i % 3) * 0.2)}" cy="${h * 0.55}" r="${Math.min(w, h) * 0.07}" fill="none" stroke="#ffdd55" stroke-width="${Math.max(4, w / 200)}"/>
    <text x="${w * 0.04}" y="${h * 0.12}" font-family="Helvetica" font-size="${Math.round(h * 0.06)}" fill="#1b2a3a">Dummy photo ${i + 1}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

export async function photoUri(i: number, w = 1600, h = 1200): Promise<{ src: string; width: number; height: number }> {
  return { src: `data:image/jpeg;base64,${(await placeholderPhoto(i, w, h)).toString('base64')}`, width: w, height: h };
}

const OBS = [
  'The fascia boards along the front elevation sit forward of the gutter line. Rainwater runs behind the gutter and down the face of the wall.',
  'The box gutter between the two roof slopes has no lining. Leaves and moss have collected along its length.',
  'A section of felt on the rear slope has been patched with a different material from the rest of the roof.',
  'Behind the new plastic boards the original timber fascia is soft to the touch and breaks away by hand.',
];
const ASSESS = [
  'In my assessment the boards were fitted without allowing for the gutter, which lets water reach the wall below.',
  'In my assessment the gutter cannot carry water away as it should while it is unlined and blocked.',
  'In my assessment the patch does not match the surrounding roof and is not a lasting repair.',
  'In my assessment the old timber should have been replaced rather than covered over.',
];
const TITLES = ['Fascias sit forward of the gutter', 'Box gutter unlined and blocked', 'Felt patched in a different material', 'Rotten timber behind new boards'];

export async function surveyFixture(opts: { findings?: number; photoCounts?: number[]; cover?: boolean; remedial?: boolean } = {}): Promise<SurveyInput> {
  const n = opts.findings ?? 4;
  const counts = opts.photoCounts ?? [1, 2, 3, 4];
  let k = 0;
  const findings = [];
  for (let i = 0; i < n; i++) {
    const c = counts[i % counts.length];
    const photos: { src: string; width: number; height: number }[] = [];
    for (let j = 0; j < c; j++) photos.push(await photoUri(k++, j % 2 === 1 && c > 2 ? 1200 : 1600, j % 2 === 1 && c > 2 ? 1600 : 1200));
    findings.push({ title: TITLES[i % 4], observation: [OBS[i % 4]], assessment: [ASSESS[i % 4]], photos });
  }
  return {
    number: 'SR-DEMO-4001',
    reportType: 'Pre-contract roof defect survey report',
    title: 'Roof Defect Survey Report',
    runningLabel: 'Pre-Contract Roof Defect Survey',
    coverSub: null,
    purpose: null,
    intro: [
      'This report has been prepared by Demo Roofing Ltd following an inspection of the roof at the above property, carried out prior to Demo Roofing Ltd undertaking any remedial works. The purpose of this survey is to record, by way of photographic evidence and professional commentary, the condition of the roof as found.',
    ],
    howToRead: 'Each finding is set out on its own page with site photographs, followed by what was observed on the roof and our professional assessment.',
    customerName: 'Mr John Smith',
    property: '123 Bromley Road, Bromley, BR1 1AA',
    dateLabel: '14 October 2026',
    preparedBy: 'Jane Demo, Demo Roofing Ltd',
    coverPhoto: opts.cover === false ? null : (await photoUri(9)).src,
    findings,
    opinion: [
      'Based on the inspection carried out and the defects recorded in this report, it is my professional opinion that the roof needs remedial work before it can be relied on to keep the building dry.',
      'The defects recorded would not be expected from work carried out to a competent standard.',
    ],
    remedial: opts.remedial === false ? null : 'Demo Roofing Ltd instructed to carry out',
    signName: 'Jane Demo',
    signRole: 'Director · Demo Roofing Ltd',
    signDateLabel: '14 October 2026',
  };
}
