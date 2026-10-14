import type { BankDetails, Customer } from '../../src/templates/finance-parts';

export const customer: Customer = {
  name: 'Mr John Smith',
  addressLines: ['123 Bromley Road', 'Bromley', 'BR2 8BG'],
  email: 'john.smith@example.com',
  phone: '07700 900123',
};

export const bank: BankDetails = {
  accountName: 'FJC Roofing Ltd',
  bankName: 'Metro Bank',
  sortCode: '00-00-00',
  accountNumber: '00000000',
};
