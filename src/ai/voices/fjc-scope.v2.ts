import { FJC_SCOPE_EXAMPLES } from '../../lib/scope/fjc-examples';
import type { ReferenceBullets, ScopeVoice } from './types';

/**
 * FJC Roofing's scope voice, version 2 (tenant data).
 *
 * Imperative bullets ("Install ...", "Remove ..."), one action per bullet, the owner's own explanations in brackets
 * kept, never a benefit clause added. The reference bullets are FJC's existing one-tap starters (generic phrasing from
 * FJC's quotations, already vetted: no customers, sizes, brands or guarantees). The headings are the ones FJC groups
 * its scopes under. The worked examples' rough steps are made up.
 */
const LABELS: Record<string, string> = { flat_roof: 'Flat roof', tiled_roof: 'Tiled roof' };
const referenceBullets: ReferenceBullets[] = Object.entries(LABELS).map(([key, jobType]) => ({
  jobType,
  bullets: (FJC_SCOPE_EXAMPLES[key]?.starters ?? []).flatMap((s) => s.steps),
}));

export const FJC_SCOPE_VOICE_V2: ScopeVoice = {
  version: 'fjc-scope-voice.v2',
  headings: [
    'Site set-up', 'Protection', 'Strip-out and removal', 'Deck preparation', 'New roof structure', 'Ventilation and eaves', 'Membrane and battens',
    'Felt roofing system', 'Gutters and valleys', 'Tiling, hips and ridges', 'Fascias', 'Guttering', 'Lead flashing', 'Finishing',
  ],
  referenceBullets,
  examples: [
    {
      jobType: 'Flat roof',
      rough: [
        {
          heading: null,
          steps: [
            'all rubbish goes on our truck no skip needed',
            'rip off the old felt back to the deck',
            'check the deck and replace any rotten boards',
            'fit a batten to the front drip edge',
            'perforated tack down layer',
            'fully bonded underlay with all edging flashings',
            'cap sheet with all edging flashings and drip edges',
          ],
        },
      ],
      wording: [
        { group: 0, heading: 'Site set-up', steps: ['All rubbish goes on our truck, no skip needed'] },
        { group: 0, heading: 'Strip-out and removal', steps: ['Strip off the old felt back to the deck'] },
        { group: 0, heading: 'Deck preparation', steps: ['Inspect the deck; replace any rotten boards', 'Install a batten to the front drip edge'] },
        {
          group: 0,
          heading: 'Felt roofing system',
          steps: ['Install a perforated tack-down layer', 'Install a fully bonded underlay with all edging flashings', 'Install a cap sheet with all edging flashings and drip edges'],
        },
      ],
      corrections: [],
      uncertain: [],
    },
    {
      jobType: 'Tiled roof',
      rough: [
        { heading: 'site set up', steps: ['right so first off scaffold to the front and side', 'um skip and materials delivered on the start date'] },
        { heading: 'strip out', steps: ['take off all the hip and ridge tiles', 'strip the tiles underfelt and batons back to the rafters'] },
        { heading: 'new roof', steps: ['eaves trays all round the perimeter', 'breathable membrane', 'new battens and tiles to match', 'dry ridge and hip system'] },
      ],
      wording: [
        { group: 0, heading: 'Site set-up', steps: ['Erect scaffold to the front and side', 'Deliver the skip and materials on the start date'] },
        { group: 1, heading: 'Strip-out', steps: ['Remove all hip and ridge tiles', 'Strip the tiles, underfelt and battens back to the rafters'] },
        {
          group: 2,
          heading: 'New roof',
          steps: ['Install eaves trays around the whole perimeter', 'Install a breathable membrane', 'Install new battens and tiles to match', 'Install a dry ridge and hip system'],
        },
      ],
      corrections: ["Read 'right so first off' as: (removed)", "Read 'um' as: (removed)", "Read 'batons' as 'battens'"],
      uncertain: [],
    },
    {
      jobType: 'Fascias and gutters',
      rough: [
        {
          heading: null,
          steps: ['take down the gutters to get at the fascias', 'remove the old facias all round', 'new white fascias and soffits', 'put the gutters back up and change any broken fittings', 'clear up the sight'],
        },
      ],
      wording: [
        {
          group: 0,
          heading: 'Fascias',
          steps: ['Remove the gutters to allow access to the fascias', 'Remove the old fascias all round', 'Install new white fascias and soffits', 'Re-install the gutters, changing any broken fittings'],
        },
        { group: 0, heading: 'Finishing', steps: ['Clear up the site'] },
      ],
      corrections: ["Read 'facias' as 'fascias'", "Read 'sight' as 'site'"],
      uncertain: [],
    },
    {
      jobType: 'Other',
      rough: [{ heading: null, steps: ['protect the dinning room celling and floor', 'take down the old fence panels', 'fit new Harris rails', 'we will take all waste away as we go'] }],
      wording: [
        {
          group: 0,
          heading: 'The works',
          steps: ['Protect the dining room ceiling and floor', 'Remove the old fence panels', 'Fit new arris rails', 'We will take all waste away as we go'],
        },
      ],
      corrections: ["Read 'dinning' as 'dining'", "Read 'celling' as 'ceiling'", "Read 'Harris rails' as 'arris rails'"],
      uncertain: [],
    },
    {
      jobType: 'Chimney',
      rough: [{ heading: 'chimney', steps: ['take out the old lead round the chimney', 'new lead step flashing', 'sort the flaunching'] }],
      wording: [{ group: 0, heading: 'Chimney', steps: ['Remove the old lead around the chimney', 'Install new lead step flashing', 'Sort the flaunching'] }],
      corrections: [],
      uncertain: ['"Sort the flaunching": do you mean repair it or replace it?'],
    },
  ],
  checklist: [
    { key: 'access', question: 'How will you get onto the roof: scaffolding, a tower, or ladder access?', coveredBy: ['scaffold', 'scaffolding', 'ladder', 'tower', 'access', 'picker'] },
    { key: 'waste', question: 'How will the waste be taken away: a skip, or on your truck?', coveredBy: ['skip', 'waste', 'rubbish', 'truck', 'dispose', 'disposal', 'tip'] },
    { key: 'protection', question: 'Will you lay protection inside the property, for example to floors and walls?', coveredBy: ['protect', 'protection', 'sheet', 'dust'] },
    { key: 'area', question: 'Do you want to give the roof area for the key figures?', coveredBy: ['area', 'sqm', 'metre', 'meter', 'm'], onlyFor: ['roof'] },
    { key: 'guarantee', question: 'Does this job come with a guarantee, and if so for how many years?', coveredBy: ['guarantee', 'guaranteed', 'warranty'] },
    { key: 'extras', question: 'Are there any extras, a protection fee or a discount to show with the price?', coveredBy: ['extra', 'discount', 'fee'] },
  ],
};
