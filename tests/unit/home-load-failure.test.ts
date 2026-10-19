import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsTable } from '../../src/components/JobsTable';
import { HOME_LOAD_MESSAGES } from '../../src/lib/home-load-messages';
import { attempt } from '../../src/lib/log-failure';

afterEach(() => vi.restoreAllMocks());

const counts = { action: 0, quotes: 0, waiting: 0, invoice: 0, all: 0 };
const html = (loadFailed: boolean) => renderToStaticMarkup(createElement(JobsTable, { rows: [], view: 'all', counts, loadFailed }));

describe('Home when a data load fails', () => {
  it('says so calmly instead of showing an empty table that looks like lost data', () => {
    const out = html(true);
    expect(out).toContain('Some of your jobs could not be loaded. Refresh to try again.');
    expect(out).not.toContain('No jobs yet');
    expect(out).toContain('role="status"');
  });

  it('still shows the plain empty message when nothing failed', () => {
    const out = html(false);
    expect(out).toContain('No jobs yet');
    expect(out).not.toContain(HOME_LOAD_MESSAGES.jobs);
  });

  it('a failing load becomes the fallback plus a failed flag, with one safe log line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobs = await attempt('home.jobs', async () => Promise.reject(Object.assign(new Error('Mr Smith, 1 Road'), { code: '42501' })), []);
    expect(jobs).toEqual({ value: [], failed: true });
    expect(String(spy.mock.calls[0][0])).toBe('[failure] stage=home.jobs class=Error code=42501');
  });
});
