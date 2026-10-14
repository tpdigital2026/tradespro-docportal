/** Clearly dummy data for demo mode. Never shown outside it. */

export const demoSession = {
  userId: 'demo-user',
  tenantId: 'demo-tenant',
  role: 'owner' as const,
  email: 'owner@demo.invalid',
  fullName: 'Demo Owner',
  businessName: 'Demo Roofing Ltd',
};

export type DemoCustomer = {
  id: string;
  name: string;
  addressLines: string[];
  postcode: string;
  email: string | null;
  phone: string | null;
};

export const demoCustomers: DemoCustomer[] = [
  {
    id: 'demo-customer-1',
    name: 'Mr John Smith',
    addressLines: ['123 Bromley Road'],
    postcode: 'BR2 8BG',
    email: null,
    phone: null,
  },
];

export type DemoQuote = {
  id: string;
  quoteNumber: string;
  customerId: string;
  date: string;
  status: 'draft' | 'final';
};

export const demoQuotes: DemoQuote[] = [
  {
    id: 'demo-quote-1',
    quoteNumber: 'DEMO-0001',
    customerId: 'demo-customer-1',
    date: '2026-10-12',
    status: 'draft',
  },
];
