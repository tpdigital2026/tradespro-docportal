import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoginForm } from '../../src/app/login/LoginForm';
import { OTP_LENGTH, OTP_PATTERN, OTP_PLACEHOLDER } from '../../src/lib/otp';

const render = (preview?: Parameters<typeof LoginForm>[0]['preview']) => renderToStaticMarkup(createElement(LoginForm, { preview }));

describe('login form', () => {
  it('uses one code length everywhere', () => {
    expect(OTP_LENGTH).toBe(8);
    expect(OTP_PATTERN.test('12345678')).toBe(true);
    expect(OTP_PATTERN.test('123456')).toBe(false);
    const html = render({ step: 'code' });
    expect(html).toContain('8 digit code');
    expect(html).toContain(`maxLength="${OTP_LENGTH}"`);
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain(`placeholder="${OTP_PLACEHOLDER}"`);
    expect(html).not.toMatch(/\b6 digit/);
  });
  it('the sign-in copy names no code length', () => {
    expect(render({ step: 'email' })).toContain('We email you a sign-in code. No password to remember.');
  });
  it('echoes the whole address on the code step, first letter included', () => {
    expect(render({ step: 'code' })).toContain('We sent an 8 digit code to owner@example.com.');
  });
  it('keeps the email field read-only in the server markup, so nothing typed before hydration can be lost', () => {
    const html = render(); // no preview: this is what the browser gets before React takes over
    expect(html).toMatch(/<input[^>]*id="email"[^>]*readOnly=""/);
  });
});
