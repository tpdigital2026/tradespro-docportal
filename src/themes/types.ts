export interface Tenant {
  name: string;
  addressLine: string;
  phone: string;
  email: string;
  web: string;
  companyNo: string;
  vatNo: string | null;
  tagline: string;
}

export interface BrandAssets {
  logoColour: string;
  logoWhite: string;
  signature: string;
  coverPhoto: string;
  diagram: string;
}

export interface Brand {
  colours: Record<string, string>;
  assets: BrandAssets;
}
