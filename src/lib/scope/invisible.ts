/**
 * Invisible characters: soft hyphen, zero-width joiner and space, bidi marks, variation selectors, fillers and the
 * rest of the format (Cf) and default-ignorable set. They split a word for a checker while looking whole to a
 * reader ("gua­rantee"), so they are removed from everything the owner types and from everything the AI
 * returns before any check, and before anything is shown or printed.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const HAS_INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/** Non-breaking spaces and the blank braille cell look like spaces but are not whitespace to every check. */
const LOOKS_LIKE_SPACE = /[\u00A0\u202F\u2007\u2800]/g;

export const plainSpaces = (t: string): string => t.replace(LOOKS_LIKE_SPACE, ' ');
export const stripInvisible = (t: string): string => plainSpaces(t).replace(INVISIBLE, '');
export const hasInvisible = (t: string): boolean => HAS_INVISIBLE.test(t);
