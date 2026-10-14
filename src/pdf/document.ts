import { html, raw, type Raw } from '../lib/html';

const CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

export function documentShell(opts: { title: string; css: string; body: Raw }): string {
  return html`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${opts.title}</title><style>${raw(opts.css)}</style></head><body>${opts.body}</body></html>`.value;
}
