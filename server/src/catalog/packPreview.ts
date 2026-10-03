/**
 * What the UI shows about a modpack before it's deployed (or linked), the same
 * shape for FTB and CurseForge. `description` is the small Markdown subset the
 * UI renders as React elements (never as HTML); image URLs are only ever on
 * http/artwork.ts's allowed hosts.
 */
export interface PackPreview {
  id: number;
  name: string;
  summary: string;
  description: string;
  artUrl: string | null;
  bannerUrl: string | null;
  screenshots: { title: string; thumbnailUrl: string; url: string }[];
  authors: string[];
  tags: string[];
  /** FTB installs / CurseForge downloads. */
  downloads: number;
  /** ISO dates. */
  updatedAt: string | null;
  releasedAt: string | null;
  websiteUrl: string | null;
  links: { name: string; url: string }[];
}
