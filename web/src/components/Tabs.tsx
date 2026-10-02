import type { KeyboardEvent, ReactNode } from "react";

/** Segmented tab strip. Arrow keys move between tabs, as screen-reader users expect of a tablist. */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
    onChange(next.value);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.value}"]`)?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          data-tab={o.value}
          aria-selected={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
