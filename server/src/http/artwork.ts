/**
 * Hosts pack artwork may be loaded from: FTB's and CurseForge's own CDNs. The
 * CSP's img-src allows exactly these, and the catalog clients drop artwork
 * URLs on any other host (a pack falls back to a placeholder) — so the UI
 * never shows a CSP-blocked image, and the CSP never has to be loosened for
 * whatever host some pack author linked.
 */
export const ARTWORK_HOSTS = ["https://cdn.feed-the-beast.com", "https://media.forgecdn.net"];

export function allowedArtworkUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return ARTWORK_HOSTS.includes(new URL(url).origin) ? url : null;
  } catch {
    return null;
  }
}
