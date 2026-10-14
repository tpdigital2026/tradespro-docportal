import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnvLine, redactSecrets } from '../../src/db/env';

const URL_ = 'postgresql://u:p%40ss-w0rd@host:5432/db';

describe('redactSecrets', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = URL_;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it('removes the whole URL', () => {
    expect(redactSecrets(`failed ${URL_} here`)).toBe('failed [redacted] here');
  });
  it('removes the raw (encoded) password', () => {
    expect(redactSecrets('bad p%40ss-w0rd')).toBe('bad [redacted]');
  });
  it('removes the decoded password', () => {
    expect(redactSecrets('bad p@ss-w0rd')).toBe('bad [redacted]');
  });
  it('leaves other messages unchanged', () => {
    expect(redactSecrets('connection refused')).toBe('connection refused');
  });
});

describe('parseEnvLine', () => {
  it('reads a plain value', () => expect(parseEnvLine('DATABASE_URL=abc')).toBe('abc'));
  it('strips double and single quotes', () => {
    expect(parseEnvLine('DATABASE_URL="abc"')).toBe('abc');
    expect(parseEnvLine("DATABASE_URL='abc'")).toBe('abc');
  });
  it('strips a leading export and CR', () => expect(parseEnvLine('export DATABASE_URL=abc\r')).toBe('abc'));
  it('ignores other keys', () => expect(parseEnvLine('OTHER=abc')).toBeNull());
});
