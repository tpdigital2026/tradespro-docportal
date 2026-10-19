import type { QuotationInput } from '../../src/templates/quotation';

export const quotationFixture: QuotationInput = {
  ref: 'QT-JS-001',
  dateLabel: '21 September 2026',
  validityDays: 30,
  customer: { name: 'Mr John Smith', email: 'john.smith@example.com', phone: '07700 900123' },
  property: '123 Bromley Road, BR2 8BG',
  coverEyebrow: 'Residential · Flat Roof Installation Quotation',
  coverTitle: 'Flat Roof Installation Quotation',
  coverSub: 'Complete flat roof installation, full scope of works and pricing',
  introText:
    'FJC Roofing Ltd is pleased to present this quotation for a complete flat roof installation at 123 Bromley Road, BR2 8BG. This document sets out the full scope of works, materials, and pricing for the project.',
  specHeading: 'The system we are installing',
  specCards: [
    { big: '3-Layer Felt', label: 'Roofing system' },
    { big: 'Code 4 Lead', label: 'Perimeter flashing' },
    { big: '20 Years', label: 'Guarantee', accent: true },
  ],
  diagram: {
    eyebrow: 'Beneath the finish',
    heading: 'Every layer has a job to do',
    body: 'A 2mm perforated tack-down layer, a 3mm fully bonded underlay and a 5mm mineral cap sheet work together as one system, finished with Code 4 lead flashing to the perimeter wall.',
    caption: 'Example felt flat roofing build-up. The exact system can vary depending on the roof and specification required.',
  },
  callout: null,
  scopeHeading: 'What we will do, step by step',
  scope: [
    {
      heading: 'Site set-up',
      bullets: [
        'All waste materials will be taken via our flatbed truck to a skip at our yard, keeping the site clear and tidy throughout the works.',
        'Protection will be laid to the floors and walls within the property where needed, covering the rooms our team will need to pass through to gain access to the roof.',
      ],
    },
    {
      heading: 'Strip-out & removal',
      bullets: [
        'The existing decking area will be removed in full, along with its structural base.',
        'The original roof covering will be removed, exposing the insulation beneath.',
        'A full inspection of the insulation will be carried out to guarantee there is no dampness before the new roof is installed.',
        'All edging covering the flashing detail will be removed, ready for the new edge flashings to be installed.',
      ],
    },
    {
      heading: 'Decking & drainage',
      bullets: [
        '9mm OSB ply boards will be installed across the roof, providing a solid, stable deck for the new felt roof system.',
        'An internal outlet will be installed to the flat roof, allowing for more drainage so that water clears from the roof surface freely.',
      ],
    },
    {
      heading: 'Waterproofing',
      bullets: [
        'A 2mm perforated tack-down layer of felt will be installed as the first layer of the system, allowing the roof to vent and helping to prevent blistering of the layers above.',
        'A 3mm fully bonded underlay will be installed with all edging flashings, providing a fully sealed base layer across the whole roof.',
        'A 5mm mineral cap sheet will be installed with all edging flashings, giving the roof a durable, weather-resistant finish.',
      ],
    },
    {
      heading: 'Lead flashing',
      bullets: [
        'Code 4, 6-inch lead flashing will be installed to the perimeter wall, encapsulating all felt flashings and ensuring a fully weathertight junction between the roof and the wall.',
      ],
    },
  ],
  guarantee: {
    years: 20,
    text: 'The roofing system specified above has been selected specifically for this project, and allows FJC Roofing Ltd to provide a 20-year guarantee on completion of the works.',
  },
  vatRateBp: 2000,
  lines: [
    {
      description: 'Flat roof installation, 123 Bromley Road, complete works as specified above',
      kind: 'Work',
      qty: 1,
      unitNetPence: 735500,
      vatApplies: true,
    },
    {
      description: 'Protection fee, protection of floors and walls in the property where needed',
      kind: 'Fee',
      qty: 1,
      unitNetPence: 15000,
      vatApplies: true,
    },
  ],
  terms:
    'This quotation is valid for 30 days from the date above. All materials supplied and installed as part of this contract remain the property of FJC Roofing Ltd until paid for in full.',
  disclaimer:
    'This quotation is generated using third-party software. The platform is not a party to any contract formed between the customer and the trader for the services listed within this document. The platform has not benchmarked, endorsed, or verified the services or prices stated. For information on how personal data is processed, please refer to the relevant Privacy Notice.',
};

/** A short job with no guarantee and no diagram: its scope shares the specification page, and the last contents cell is split into Pricing and Terms. */
export const shortQuotationFixture: QuotationInput = {
  ...quotationFixture,
  ref: 'QT-BR-003',
  coverEyebrow: 'Residential · Fascia Replacement Quotation',
  coverTitle: 'Fascia Replacement Quotation',
  coverSub: 'Full replacement fascias to the entire property, full scope of works and pricing',
  introText: 'FJC Roofing Ltd is pleased to present this quotation for fascia replacement at 123 Bromley Road. This document sets out the full scope of works and pricing.',
  specHeading: 'Your new roofline',
  specEyebrow: 'Specification',
  specCards: [
    { big: '18mm', label: 'Full replacement fascias' },
    { big: 'White', label: 'Fascia finish' },
    { big: 'Guttering', label: 'Re-installed' },
    { big: 'Entire Property', label: 'Including the apex' },
  ],
  diagram: null,
  scope: [
    { heading: 'Removal process', bullets: ['Remove all guttering and fittings to allow access to the fascias.', 'Remove the current fascia boards to the entire property.'] },
    { heading: 'Fascias', bullets: ['Install full-replacement 18mm fascias (white) to the entire property, including the apex.'] },
    { heading: 'Guttering', bullets: ['Re-install guttering, changing any damaged or broken fittings.'] },
  ],
  guarantee: null,
  lines: [{ description: 'Fascia replacement – 123 Bromley Road, complete works as specified above', kind: 'Work', qty: 1, unitNetPence: 167833, vatApplies: true }],
};
