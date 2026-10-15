import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingFiles } from '../../scripts/check-render-bundle';
import { describeFailure, inStage, logRenderFailure, stageOf, tagFailures, tagStage } from '../../src/pdf/diagnostics';
import { renderEngine, renderRuntime } from '../../src/pdf/engine';
import { PageOverflowError } from '../../src/pdf/render';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('engine selection', () => {
  it('Vercel means serverless, and serverless always means puppeteer', () => {
    expect(renderRuntime({ VERCEL: '1' })).toBe('serverless');
    expect(renderEngine({ VERCEL: '1' })).toBe('puppeteer');
    expect(renderEngine({ VERCEL: '1', RENDER_ENGINE: 'playwright' })).toBe('puppeteer');
    expect(renderEngine({ RENDER_RUNTIME: 'serverless' })).toBe('puppeteer');
  });

  it('locally the default is playwright, and RENDER_ENGINE=puppeteer switches', () => {
    expect(renderRuntime({})).toBe('local');
    expect(renderEngine({})).toBe('playwright');
    expect(renderEngine({ RENDER_ENGINE: ' Puppeteer ' })).toBe('puppeteer');
    expect(renderEngine({ RENDER_ENGINE: 'something-else' })).toBe('playwright');
    expect(renderRuntime({ VERCEL: '1', RENDER_RUNTIME: 'local' })).toBe('local');
  });
});

describe('stage tags', () => {
  it('keep the original error and its class; the first stage wins', async () => {
    const e = new PageOverflowError('page 2: content overflows the page');
    await expect(inStage('check', () => Promise.reject(e))).rejects.toBe(e);
    tagStage(e, 'pdf');
    expect(stageOf(e)).toBe('check');
    expect(e).toBeInstanceOf(PageOverflowError);
    expect(Object.keys(e)).not.toContain('stage');
  });

  it('tag storage failures, sync or async, without changing results', async () => {
    const store = {
      n: 0,
      async put(): Promise<void> {
        throw Object.assign(new Error('bucket says no'), { code: 'StorageApiError' });
      },
      get(): string {
        this.n += 1;
        return 'ok';
      },
    };
    const tagged = tagFailures(store, 'upload');
    expect(tagged.get()).toBe('ok');
    expect(store.n).toBe(1);
    const err = await tagged.put().catch((x: unknown) => x);
    expect(stageOf(err)).toBe('upload');
  });
});

describe('failure log line', () => {
  it('never carries the message of a stage that has seen the document', () => {
    const e = tagStage(new Error('Evaluation failed: Mrs Customer, 1 Private Road'), 'layout');
    const d = describeFailure('preview', e);
    expect(d).toMatchObject({ event: 'render_failed', where: 'preview', stage: 'layout', error: 'Error' });
    expect(JSON.stringify(d)).not.toContain('Private Road');
    expect(d.detail).toBeUndefined();
  });

  it('keeps a short message for launch failures, which run before any document exists', () => {
    const e = tagStage(Object.assign(new Error('Failed to launch the browser process\nlibnss3.so: cannot open shared object file'), { code: 'ENOENT' }), 'launch');
    const d = describeFailure('preview', e);
    expect(d.stage).toBe('launch');
    expect(d.code).toBe('ENOENT');
    expect(d.detail).toContain('libnss3.so');
    expect(String(d.detail)).not.toContain('\n');
  });

  it('untagged errors are reported as prepare; non-errors do not throw', () => {
    expect(describeFailure('finalise', new TypeError('x')).stage).toBe('prepare');
    expect(describeFailure('finalise', 'boom')).toMatchObject({ stage: 'prepare', error: 'string' });
  });

  it('writes exactly one [render] JSON line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logRenderFailure('signature', tagStage(new Error('secret'), 'decode'));
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line.startsWith('[render] {')).toBe(true);
    expect(JSON.parse(line.slice('[render] '.length))).toMatchObject({ where: 'signature', stage: 'decode' });
    expect(line).not.toContain('secret');
  });
});

describe('render bundle check', () => {
  it('reports missing files, folders and hashed links', () => {
    const traced = ['node_modules/@sparticuz/chromium/bin/chromium.br', 'node_modules/tar-fs/index.js', '.next/node_modules/puppeteer-core-abc123'];
    expect(missingFiles(traced, ['node_modules/@sparticuz/chromium/bin/chromium.br', 'node_modules/tar-fs/', '.next/node_modules/puppeteer-core-*'])).toEqual([]);
    expect(missingFiles(traced, ['node_modules/@sparticuz/chromium/bin/al2023.tar.br', 'public/brands/fjc/', '.next/node_modules/@sparticuz/chromium-*'])).toEqual([
      'node_modules/@sparticuz/chromium/bin/al2023.tar.br',
      'public/brands/fjc/',
      '.next/node_modules/@sparticuz/chromium-*',
    ]);
  });
});
