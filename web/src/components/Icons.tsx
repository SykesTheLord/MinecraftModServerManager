/** Inline SVG icons (elements, not inline styles — fine under the CSP). */

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c9bff" />
          <stop offset="1" stopColor="#3fc28a" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#brand-g)" />
      <path d="M9 11h5v5H9zM18 11h5v5h-5zM13.5 16h5v3h2.5v5h-3v-2.5h-4V24h-3v-5h2.5z" fill="#0b0d12" opacity="0.88" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="9" cy="9" r="6" />
      <path d="m14 14 4 4" strokeLinecap="round" />
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M11 4h5v5M16 4l-7 7M14 12v4H4V6h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
