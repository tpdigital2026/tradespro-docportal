import type { Page } from 'playwright-core';
import { html, raw, type Raw } from '../lib/html';
import { documentShell } from '../pdf/document';
import { measureFragments, PX_PER_MM } from '../pdf/measure';
import { PageOverflowError } from '../pdf/render';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';
import * as P from './parts';
import { flowScope } from './scope-flow';

/**
 * The survey report, laid out like FJC's pre-contract roof defect survey: a photo cover, an introduction with the
 * index of findings, one page per finding (one to four photos, the observation and the professional assessment), and
 * the conclusion with the professional opinion, the counts and the signature.
 *
 * Everything the business says around the findings comes from its own wording (tenant data). Everything about the
 * property comes from the owner. Photos arrive as data: URIs (the page cannot reach the network).
 */
export interface SurveyPhoto {
  src: string;
  width: number;
  height: number;
}

export interface SurveyFindingInput {
  title: string;
  /** Paragraphs. */
  observation: string[];
  assessment: string[];
  /** One to four photos in order (Photo n.1, n.2 ...): data: URIs with their pixel size, so none is ever cropped. */
  photos: SurveyPhoto[];
}

export interface SurveyInput {
  number: string;
  /** The business's wording. */
  reportType: string;
  title: string;
  runningLabel: string;
  coverSub: string | null;
  purpose: string | null;
  /** Paragraphs, the business name already filled in. */
  intro: string[];
  howToRead: string | null;
  customerName: string;
  property: string;
  /** "10 August 2026" */
  dateLabel: string;
  /** "Jane Smith, Demo Roofing Ltd" */
  preparedBy: string;
  coverPhoto: string | null;
  findings: SurveyFindingInput[];
  opinion: string[];
  remedial: string | null;
  signName: string;
  signRole: string;
  signDateLabel: string;
}

const BODY_MM = 297 - 27 - 19;
const BODY_WIDTH_MM = 210 - 2 * 16;
const SAFETY_MM = 4;
/**
 * The most room the photos may take, by count, and the least they may shrink to before the page is refused. Photos
 * are evidence, so they are never cropped: each keeps its own shape inside its cell. One photo sits alone, two and
 * three side by side, four in two rows of two (the reference's four-across strip cut most of every photo away).
 */
const PHOTO_MAX_MM: Record<number, number> = { 1: 140, 2: 170, 3: 170, 4: 170 };
const MIN_PHOTO_MM = 62;
export const SINGLE_PHOTO_SHARE = 0.6;
const PHOTO_GAP_MM = 3;

/** Small additions to the shared stylesheet, for this document only. */
const SURVEY_CSS = `
.sv-cover .title h1 .l2{display:block}
.sv-cover .det .kv .v{overflow-wrap:anywhere}
.sv-cover.no-photo .shade{background:linear-gradient(180deg,rgba(15,43,74,0) 0%,rgba(15,43,74,0) 60%,rgba(15,43,74,1) 100%)}
.sv-cover.no-photo .mark{position:absolute;right:16mm;top:52mm;width:84mm;height:84mm;border-radius:50%;border:.5mm solid rgba(127,166,220,.35)}
.sv-cover.no-photo .mark::after{content:"";position:absolute;inset:11mm;border-radius:50%;border:.3mm solid rgba(127,166,220,.22)}
.sv-cover.no-purpose .det{top:auto;bottom:17mm}
.sv-cover.no-purpose .title{top:166mm}
.sv-intro{display:grid;grid-template-columns:44mm 1fr;gap:8mm}
.sv-intro .lede+.lede{margin-top:2.4mm}
.findex-row{margin-bottom:3.5mm}
.fi .t{overflow-wrap:anywhere}
.fhd h2{overflow-wrap:anywhere}
.oa p+p{margin-top:2mm}
.oa .o p,.oa .a p{overflow-wrap:anywhere}
.sv-photos{display:grid;gap:${PHOTO_GAP_MM}mm;margin-bottom:5mm}
.sv-prow{display:flex;justify-content:center;align-items:center;gap:${PHOTO_GAP_MM}mm}
.sv-photos figure{position:relative;overflow:hidden;background:var(--paper);flex:none}
.sv-photos img{width:100%;height:100%;display:block}
.sv-photos figcaption{position:absolute;left:0;bottom:0;background:var(--navy);color:#fff;font-family:"Mono";font-size:5.8pt;letter-spacing:.18em;padding:1.2mm 2.4mm;text-transform:uppercase}
.sv-opinion .lede+.lede{margin-top:2.6mm}
.sv-opinion.tight .lede{font-size:8.8pt;line-height:1.58}
.sv-stats{display:grid;gap:6mm}
.sv-stats .big{color:#fff;font-size:26pt;margin-top:1mm}
.sv-stats .txt{color:#fff;margin-top:3mm;font-size:8.6pt;line-height:1.45;overflow-wrap:anywhere}
.sign .s .typed{font-family:"Playfair";font-style:italic;font-size:17pt;color:var(--ink);line-height:1.1;padding:0 0 1.4mm 1mm;overflow-wrap:anywhere}
`;

const pad2 = P.pad2;

interface Cell {
  w: number;
  h: number;
}

/** Fits a photo inside a cell, keeping its shape. Sizes in mm, rounded down a little so rounding never overflows. */
function fit(p: SurveyPhoto, cell: Cell): Cell {
  const ar = p.width > 0 && p.height > 0 ? p.width / p.height : 4 / 3;
  const w = Math.min(cell.w, cell.h * ar);
  return { w: Math.floor(w * 10) / 10, h: Math.floor((w / ar) * 10) / 10 };
}

/** Rows of photos and the height each row takes, given the room available. Pure (exported for tests). */
/** The ways n photos can sit in rows (photos per row, top to bottom). */
const ARRANGEMENTS: Record<number, number[][]> = {
  1: [[1]],
  2: [[2], [1, 1]],
  3: [[3], [1, 2], [2, 1]],
  4: [[2, 2], [4], [1, 3], [3, 1]],
};

type Layout = { rows: { cells: Cell[]; heightMm: number }[]; heightMm: number };

function arrange(photos: SurveyPhoto[], perRows: number[], roomMm: number, widthMm: number): Layout {
  const cap = Math.min(PHOTO_MAX_MM[photos.length] ?? 104, roomMm);
  const rowCount = perRows.length;
  const rowCap = (cap - PHOTO_GAP_MM * (rowCount - 1)) / rowCount;
  const rows: Layout['rows'] = [];
  let k = 0;
  for (const per of perRows) {
    // A photo alone on its row is held to 60% of the width, as planned (the reference), so it never swamps the page.
    const cellW = per === 1 ? widthMm * SINGLE_PHOTO_SHARE : (widthMm - PHOTO_GAP_MM * (per - 1)) / per;
    const cells = photos.slice(k, k + per).map((p) => fit(p, { w: cellW, h: rowCap }));
    k += per;
    rows.push({ cells, heightMm: Math.max(...cells.map((c) => c.h)) });
  }
  return { rows, heightMm: rows.reduce((t, r) => t + r.heightMm, 0) + PHOTO_GAP_MM * (rowCount - 1) };
}

/**
 * Rows of photos and the height each row takes, given the room available. Pure (exported for tests). Of the ways the
 * photos can be arranged, the one that shows them largest wins (two landscape photos side by side, two portrait ones
 * too; with room to spare, landscape photos stack), always in order and never cropped.
 */
export function photoLayout(photos: SurveyPhoto[], roomMm: number, widthMm = BODY_WIDTH_MM): Layout {
  const options = ARRANGEMENTS[photos.length] ?? [[photos.length]];
  let best: Layout | null = null;
  let bestScore = -1;
  for (const o of options) {
    const l = arrange(photos, o, roomMm, widthMm);
    // The smallest photo matters most: each must stay readable, then the bigger total wins.
    const areas = l.rows.flatMap((r) => r.cells.map((c) => c.w * c.h));
    const score = Math.min(...areas) * 2 + areas.reduce((t, x) => t + x, 0) / areas.length;
    if (score > bestScore + 1) {
      best = l;
      bestScore = score;
    }
  }
  return best as Layout;
}

function photoGrid(photos: SurveyPhoto[], findingNo: number, roomMm: number): Raw {
  const { rows } = photoLayout(photos, roomMm);
  let k = 0;
  return html`<div class="sv-photos">${rows.map(
    (r) =>
      html`<div class="sv-prow" style="height:${r.heightMm}mm">${r.cells.map((c) => {
        k += 1;
        const p = photos[k - 1];
        return html`<figure style="width:${c.w}mm;height:${c.h}mm"><img src="${p.src}" alt="Photo ${findingNo}.${k}"><figcaption>Photo ${findingNo}.${k}</figcaption></figure>`;
      })}</div>`,
  )}</div>`;
}

function findingHead(i: number, title: string): Raw {
  return html`<div class="fhd"><div class="n"><small>Finding</small>${pad2(i)}</div><h2>${title}</h2></div>`;
}

function findingText(f: SurveyFindingInput): Raw {
  return html`<div class="oa"><div class="o"><span class="eyebrow">Observation</span>${f.observation.map((p) => html`<p>${p}</p>`)}</div><div class="a"><span class="eyebrow">Professional assessment</span>${f.assessment.map((p) => html`<p>${p}</p>`)}</div></div>`;
}

/** "Roof Defect Survey Report" becomes "Roof Defect / Survey Report" on the cover, so the title sits on two lines. */
function coverTitle(title: string): Raw {
  const words = title.trim().split(/\s+/);
  if (words.length < 3) return html`${title}`;
  const cut = Math.ceil(words.length / 2);
  return html`${words.slice(0, cut).join(' ')} <span class="l2">${words.slice(cut).join(' ')}</span>`;
}

function typedSign(name: string, role: string, date: string): Raw {
  return html`<div class="sign"><div class="s"><div class="typed">${name}</div><div class="line"><div class="nm">${name}</div><div class="rl">${role}</div></div></div><div class="small" style="padding-bottom:1mm">Typed signature<br>${date}</div></div>`;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
/** "Six findings" at the start of a heading; figures from 11 up. */
const countWords = (n: number, one: string, many: string) => `${n <= 10 ? WORDS[n] : n} ${n === 1 ? one : many}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function buildSurvey(page: Page, input: SurveyInput, tenant: Tenant, brand: Brand): Promise<string> {
  if (input.findings.length === 0) throw new Error('A survey report needs at least one finding');
  if (input.findings.some((f) => f.photos.length < 1 || f.photos.length > 4)) throw new Error('Each finding needs one to four photos');
  const css = `${documentCss(brand)}\n${SURVEY_CSS}`;
  const nFind = input.findings.length;
  const nPhotos = input.findings.reduce((s, f) => s + f.photos.length, 0);
  const defects = plural(nFind, 'defect recorded', 'defects recorded');
  const photosLabel = plural(nPhotos, 'site photograph', 'site photographs');

  // 1. The index of findings flows over as many pages as it needs (two findings to a row).
  const intro = html`<div class="sv-intro"><div><span class="eyebrow">Introduction</span><h2 style="margin-top:1.5mm">About this report</h2><div class="rule"></div></div><div>${input.intro.map((p) => html`<p class="lede">${p}</p>`)}</div></div>`;
  const indexHead = html`${intro}<div style="margin-top:9mm"><span class="eyebrow">Summary of findings</span><h2>${countWords(nFind, 'finding', 'findings')} recorded</h2><div class="rule"></div></div>`;
  const indexHeadRest = html`<span class="eyebrow">Summary of findings, continued</span><div style="height:4mm"></div>`;
  // Page numbers are not known yet; a two-digit placeholder measures the same.
  const fiCard = (i: number, title: string, pg: number) => html`<div class="fi"><div class="n">${pad2(i)}</div><div><div class="t">${title}</div><div class="pg">Finding ${pad2(i)} · Page ${pad2(pg)}</div></div></div>`;
  const rowsOf = (pageOf: (i: number) => number): Raw[] => {
    const rows: Raw[] = [];
    for (let i = 0; i < nFind; i += 2) {
      const pair = input.findings.slice(i, i + 2);
      rows.push(html`<div class="findex findex-row">${pair.map((f, k) => fiCard(i + k + 1, f.title, pageOf(i + k + 1)))}</div>`);
    }
    return rows;
  };
  const panel = (conclusionPage: number) =>
    html`<div class="panel" style="margin-top:4.5mm;display:grid;grid-template-columns:${input.howToRead ? '1fr 1fr' : '1fr'};gap:8mm">${input.howToRead ? html`<div><span class="eyebrow">How to read this report</span><p style="margin-top:1.5mm">${input.howToRead}</p></div>` : null}<div><span class="eyebrow">Conclusion</span><p style="margin-top:1.5mm">The overall professional opinion is given on the final page of this report, page ${pad2(conclusionPage)}.</p></div></div>`;
  const { groups } = await flowScope({
    page,
    css,
    widthMm: BODY_WIDTH_MM,
    firstAreaMm: BODY_MM,
    restAreaMm: BODY_MM,
    headFirst: indexHead,
    headRest: indexHeadRest,
    sections: rowsOf(() => 99),
    trailing: [panel(99)],
  });
  const indexPages = groups.length;
  const findingPage = (i: number) => 1 + indexPages + i;
  const total = 1 + indexPages + nFind + 1;
  if (total > 99) throw new PageOverflowError('The survey report is too long');
  const rows = rowsOf(findingPage);
  const items = [...rows, panel(total)];

  const header = P.runningHeader(tenant, brand, input.runningLabel, input.number);
  const footer = (n: number) => P.runningFooter(tenant, n, total);

  // 2. Cover.
  const det: [string, string][] = [
    ['Client', input.customerName],
    ['Survey date', input.dateLabel],
    ['Property', input.property],
    ['Prepared by', input.preparedBy],
    ['Findings', defects],
    ['Photographs', photosLabel],
  ];
  const coverPhoto = input.coverPhoto ? html`<div class="ph" style="background-image:url(&quot;${input.coverPhoto}&quot;)"></div>` : html`<div class="mark"></div>`;
  const cover = html`<section class="page"><div class="sv-cover${input.coverPhoto ? '' : ' no-photo'}${input.purpose ? '' : ' no-purpose'}">${coverPhoto}<div class="shade"></div><div class="top"><img src="${brand.assets.logoWhite}" alt="${tenant.name}"><div class="contact">${P.contactLines(tenant)}</div></div><div class="title" data-fit><span class="eyebrow w">${input.reportType}</span><h1>${coverTitle(input.title)}</h1><div class="rule"></div>${input.coverSub ? html`<div class="sub">${input.coverSub}</div>` : html`<div class="sub">Report ${input.number}</div>`}</div><div class="det">${det.map(([k, v]) => P.kv(k, v))}</div>${input.purpose ? html`<div class="purpose" data-reserved><span class="eyebrow g">Purpose</span>${input.purpose}</div>` : null}</div></section>`;

  // 3. Introduction and index.
  const indexPagesHtml = groups.map((g, gi) => P.page(html`${gi === 0 ? indexHead : indexHeadRest}<div>${g.map((idx) => items[idx])}</div>`, header, footer(2 + gi)));

  // 4. One page per finding. The photos give way (down to a floor) so long wording never runs off the page.
  const heads = input.findings.map((f, i) => findingHead(i + 1, f.title));
  const texts = input.findings.map(findingText);
  const measured = await measureFragments(page, css, BODY_WIDTH_MM, [...heads, ...texts]);
  const findingPages = input.findings.map((f, i) => {
    const used = measured[i] + measured[nFind + i];
    // 5mm under the photo grid (.photos margin), plus the figure caption sits inside the photo.
    const room = (BODY_MM - SAFETY_MM - 5) - used / PX_PER_MM;
    if (Math.min(PHOTO_MAX_MM[f.photos.length], room) < MIN_PHOTO_MM) throw new PageOverflowError(`Finding ${i + 1} has too much wording to fit on its page with its photos. Shorten the observation or the assessment.`);
    return P.page(html`${heads[i]}${photoGrid(f.photos, i + 1, Math.floor(room))}${texts[i]}`, header, footer(findingPage(i + 1)));
  });

  // 5. Conclusion.
  const statCols = input.remedial ? 'repeat(3,1fr)' : 'repeat(2,1fr)';
  const stats = html`<div class="panel navy sv-stats" style="margin-top:10mm;grid-template-columns:${statCols}"><div><span class="eyebrow w">Defects recorded</span><div class="serif big">${nFind}</div></div><div><span class="eyebrow w">Site photographs</span><div class="serif big">${nPhotos}</div></div>${input.remedial ? html`<div><span class="eyebrow w">Remedial works</span><div class="txt">${input.remedial}</div></div>` : null}</div>`;
  const sign = html`<div style="margin-top:14mm"><span class="eyebrow">Prepared by</span><div style="margin-top:4mm">${typedSign(input.signName, input.signRole, input.signDateLabel)}</div></div>`;
  const opinionBlock = (tight: boolean) => html`<span class="eyebrow">Conclusion</span><h2>Professional opinion</h2><div class="rule"></div><div class="sv-opinion${tight ? ' tight' : ''}">${input.opinion.map((p) => html`<p class="lede">${p}</p>`)}</div>`;
  const [hLoose, hTight, hRest] = await measureFragments(page, css, BODY_WIDTH_MM, [opinionBlock(false), opinionBlock(true), html`${stats}${sign}`]);
  const roomPx = (BODY_MM - SAFETY_MM) * PX_PER_MM - hRest;
  if (hTight > roomPx) throw new PageOverflowError('The professional opinion is too long to fit on the last page with the signature. Shorten it.');
  const conclusion = P.page(html`${opinionBlock(hLoose > roomPx)}${stats}${sign}`, header, footer(total));

  const pages = [cover, ...indexPagesHtml, ...findingPages, conclusion];
  return documentShell({ title: `${tenant.name} ${input.title} ${input.number}`, css, body: raw(pages.map((p) => p.value).join('')) });
}
