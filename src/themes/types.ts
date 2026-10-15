export interface Tenant {
  name: string;
  addressLine: string;
  phone: string;
  email: string;
  web: string;
  companyNo: string;
  vatNo: string | null;
  tagline: string;
  ownerName: string;
  ownerTitle: string;
}

export interface BrandAssets {
  logoColour: string;
  logoWhite: string;
  /** null: no stored signature (or no consent to use it); the sign line is left blank for a hand signature. */
  signature: string | null;
  /** null: no cover photo on record; the cover is the brand colour only. */
  coverPhoto: string | null;
  /** null: no build-up diagram on record; the diagram block is left out. */
  diagram: string | null;
}

export interface Brand {
  colours: Record<string, string>;
  assets: BrandAssets;
}
