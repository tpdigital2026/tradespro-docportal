/**
 * Materials, products and parts. The AI may not introduce one the owner did not write. Base forms are listed once;
 * the matcher also tries the word without -ing, -ed, -er, -ation and so on (see ./stems.ts), so painted, insulated,
 * guttering, glazed, plastered and sheeting are covered without any fuzzy matching. Data only.
 */
export const PRODUCT_WORDS: readonly string[] = [
  'osb', 'ply', 'plywood', 'felt', 'epdm', 'grp', 'fibreglass', 'fiberglass', 'rubber', 'bitumen', 'lead', 'zinc', 'copper', 'aluminium',
  'aluminum', 'steel', 'slate', 'tile', 'upvc', 'pvc', 'timber', 'insulation', 'insulate', 'membrane', 'underlay', 'underfelt', 'batten', 'mortar',
  'cement', 'sealant', 'mastic', 'concrete', 'brick', 'glass', 'plastic', 'polycarbonate', 'fascia', 'soffit', 'gutter', 'downpipe',
  'flashing', 'ridge', 'hip', 'valley', 'joist', 'rafter', 'scaffold', 'scaffolding', 'skip', 'chimney', 'skylight', 'velux', 'lantern',
  'decking', 'deck', 'cladding', 'render', 'paint', 'adhesive', 'screw', 'nail', 'bolt', 'vent', 'outlet', 'drain', 'drainage',
  'stone', 'wood', 'metal', 'iron', 'tar', 'asphalt', 'resin', 'foam', 'vapour', 'vapor', 'breathable', 'warm', 'lath', 'truss',
  // forms and further products
  'glaze', 'glazing', 'plaster', 'plasterboard', 'sheet', 'lintel', 'silicone', 'pir', 'torch', 'guttering',
];
