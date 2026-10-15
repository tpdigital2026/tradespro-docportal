import type { ScopeExamples } from './examples';

/**
 * FJC's suggestions, taken only from headings and generic step phrasing in FJC's own quotations. No customer
 * details, no measurements, no materials by brand or size, no guarantees. Written as instructions, so they read
 * as steps; the owner edits them, and the AI step later turns them into the customer's sentences.
 *
 * Gaps (the reference pack has nothing to take wording from, so nothing is invented):
 * - fascia: no fascia quotation scope headings exist in the pack's code (only a survey report about someone else's
 *   fascias), so this job type keeps only the headings that FJC uses on every job.
 * - other: same, only the shared headings and steps.
 */

const INTRO = 'FJC Roofing Ltd is pleased to present this quotation. This document sets out the full scope of works, materials, and pricing for the project.';

const SITE = {
  heading: 'Site set-up',
  steps: ['Erect scaffolding to give safe working access', 'Provide skips for the removal and disposal of waste materials', 'Lay protection to floors and walls where needed'],
};

export const FJC_SCOPE_EXAMPLES: Record<string, ScopeExamples> = {
  flat_roof: {
    intro: INTRO,
    specLabels: ['Roofing system', 'Perimeter flashing', 'Total roof area', 'Guarantee'],
    headings: ['Site set-up', 'Strip-out and removal', 'Deck preparation', 'Decking and drainage', 'Felt roofing system', 'Waterproofing', 'Lead flashing and finish'],
    starters: [
      { heading: 'Site set-up', steps: ['Lay protection to floors and walls where needed', 'Take all waste materials away to keep the site clear and tidy'] },
      {
        heading: 'Strip-out and removal',
        steps: ['Remove the existing roof covering', 'Remove the existing decking', 'Inspect the insulation to make sure it is dry before the new roof is installed', 'Remove the existing edge flashings ready for the new ones'],
      },
      { heading: 'Decking and drainage', steps: ['Install new ply boards across the roof to form a solid, stable deck', 'Install an outlet to the flat roof so that water clears freely'] },
      {
        heading: 'Felt roofing system',
        steps: ['Install a perforated tack-down layer', 'Install a fully bonded underlay with all edging flashings', 'Install a mineral cap sheet with all edging flashings and drip edges'],
      },
      { heading: 'Lead flashing and finish', steps: ['Install lead flashing to the house wall, covering the edging flashings'] },
    ],
    sequences: [
      {
        key: 'flat_roof_typical',
        label: 'Flat roof, typical order of work',
        sections: [
          { heading: 'Site set-up', steps: ['Lay protection to floors and walls where needed', 'Take all waste materials away to keep the site clear and tidy'] },
          { heading: 'Strip-out and removal', steps: ['Remove the existing roof covering', 'Inspect the deck to make sure it is in good enough condition', 'Remove the existing edge flashings ready for the new ones'] },
          { heading: 'Felt roofing system', steps: ['Install a perforated tack-down layer', 'Install a fully bonded underlay with all edging flashings', 'Install a mineral cap sheet with all edging flashings and drip edges'] },
          { heading: 'Lead flashing and finish', steps: ['Install lead flashing to the house wall, covering the edging flashings'] },
        ],
      },
    ],
  },
  tiled_roof: {
    intro: INTRO,
    specLabels: ['Total roof area', 'Roof tiles', 'Hip and ridge system', 'Guarantee'],
    headings: ['Site set-up', 'Strip-out and removal', 'Waterproofing and ventilation', 'Battens and tiling', 'Flashings'],
    starters: [
      {
        heading: 'Site set-up',
        steps: ['Erect scaffolding to give safe working access', 'Provide skips for the removal and disposal of waste materials', 'Deliver all roofing materials to site on the agreed start date'],
      },
      {
        heading: 'Strip-out and removal',
        steps: ['Remove all ridge and hip tiles', 'Remove all existing roof tiles', 'Remove all existing flashings, ready for the new ones', 'Remove all battens and any remaining underfelt, exposing the rafters'],
      },
      {
        heading: 'Waterproofing and ventilation',
        steps: ['Install over-fascia vents around the roofline', 'Install eaves support trays to the full perimeter of the roof', 'Install a breathable membrane across the whole roof', 'Install valley trays'],
      },
      { heading: 'Battens and tiling', steps: ['Install pressure-treated battens', 'Install the new tiles across the roof', 'Install a dry hip and ridge system, with all hips and ridges mechanically fixed'] },
      { heading: 'Flashings', steps: ['Install lead flashing to up-stand walls and the more complex areas of the building'] },
    ],
    sequences: [
      {
        key: 'tiled_roof_typical',
        label: 'Tiled roof, typical order of work',
        sections: [
          { heading: SITE.heading, steps: SITE.steps.slice(0, 2).concat(['Deliver all roofing materials to site on the agreed start date']) },
          { heading: 'Strip-out and removal', steps: ['Remove all ridge and hip tiles', 'Remove all existing roof tiles', 'Remove all battens and any remaining underfelt, exposing the rafters'] },
          { heading: 'Waterproofing and ventilation', steps: ['Install over-fascia vents around the roofline', 'Install eaves support trays to the full perimeter of the roof', 'Install a breathable membrane across the whole roof'] },
          { heading: 'Battens and tiling', steps: ['Install pressure-treated battens', 'Install the new tiles across the roof', 'Install a dry hip and ridge system, with all hips and ridges mechanically fixed'] },
          { heading: 'Flashings', steps: ['Install lead flashing to up-stand walls and the more complex areas of the building'] },
        ],
      },
    ],
  },
  fascia: {
    intro: INTRO,
    specLabels: ['Guarantee'],
    headings: ['Site set-up', 'Strip-out and removal'],
    starters: [{ heading: SITE.heading, steps: SITE.steps }],
    sequences: [],
  },
  other: {
    intro: INTRO,
    specLabels: ['Guarantee'],
    headings: ['Site set-up', 'Strip-out and removal'],
    starters: [{ heading: SITE.heading, steps: SITE.steps }],
    sequences: [],
  },
};
