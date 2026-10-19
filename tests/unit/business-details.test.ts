import { describe, expect, it } from 'vitest';
import { displayWebsite, parseBusinessDetails } from '../../src/lib/validation/business';

const ok = { email: 'Ben@example.com', phone: '07000 000000', website: 'https://example.co.uk/', tagline: 'Covering your home', addressLines: ['1 Dummy Road', 'Anytown'], postcode: 'me3 9ud', companyNumber: '12345678', vatNumber: 'GB 123456789', ownerName: 'Dummy Owner', ownerTitle: 'Director' };

describe('Settings > Business details validation', () => {
  it('accepts good details and prints the website without the scheme or trailing slash', () => {
    const r = parseBusinessDetails(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.website).toBe('example.co.uk');
    expect(r.value.postcode).toBe('ME3 9UD');
    expect(r.value.email).toBe('Ben@example.com');
    expect(displayWebsite('https://fjcroofing.co.uk/')).toBe('fjcroofing.co.uk');
    expect(displayWebsite('www.Example.co.uk/about')).toBe('www.example.co.uk/about');
  });
  it('every field may be blank: nothing is required', () => {
    const r = parseBusinessDetails({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.values(r.value).every((x) => (Array.isArray(x) ? x.length === 0 : x === ''))).toBe(true);
  });
  it('refuses a bad email, website, phone, company or VAT number, too many address lines and control characters', () => {
    const r = parseBusinessDetails({ email: 'not an email', website: 'javascript:alert(1)', phone: 'call me', companyNumber: '123', vatNumber: 'VAT', addressLines: ['a', 'b', 'c', 'd', 'e'], tagline: 'x\u0007y' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['addressLines', 'companyNumber', 'email', 'phone', 'tagline', 'vatNumber', 'website']);
  });
});
