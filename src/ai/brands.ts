/**
 * Brand and manufacturer names (lowercase, one word each) that must never appear in tidied wording unless the owner
 * wrote them. Data, so it can grow without touching the check. Matched on the word's stem, in any position and case.
 */
export const BRANDS: readonly string[] = [
  'marley', 'ludlow', 'redland', 'monier', 'sandtoft', 'wienerberger', 'klober', 'cupa', 'tapco', 'timloc', 'ubbink', 'manthorpe',
  'iko', 'rubbershield', 'armourplan', 'firestone', 'rubbercover', 'sika', 'sarnafil', 'bauder', 'soprema', 'icopal', 'permaroof',
  'cmc', 'resitrix', 'liquiroof', 'tor', 'kingspan', 'celotex', 'recticel', 'xtratherm', 'unilin', 'velux', 'keylite', 'fakro',
  'wickes', 'screwfix', 'travis', 'jewson', 'selco', 'checkatrade', 'trustmark', 'nhbc', 'ciob', 'nfrc', 'constructionline',
  'upvc', 'epdm', 'grp', 'tpo', 'pvc', 'osb', 'lafarge', 'hanson', 'ibstock', 'brett', 'aluk', 'rehau', 'liniar', 'freefoam',
];
