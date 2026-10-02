const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function formatCount(n: number): string {
  return compact.format(n);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatMemory(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 weeks ago" from a Date, an ISO string, or unix seconds. */
export function timeAgo(value: Date | string | number | null | undefined): string {
  if (value == null) return "—";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  const seconds = (date.getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** A DNS-label-safe suggestion from a pack name: "FTB StoneBlock 3" → "ftb-stoneblock-3". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** HTML `pattern` for a subdomain; mirrors the server's validateSubdomain (a single DNS label). */
export const SUBDOMAIN_PATTERN = "[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?";
export const SUBDOMAIN_HINT = "Lowercase letters, digits and hyphens; can't start or end with a hyphen";
