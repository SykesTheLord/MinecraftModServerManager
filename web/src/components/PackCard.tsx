import type { ReactNode } from "react";

export function PackArt({ url, name, square = false }: { url: string | null; name: string; square?: boolean }) {
  return (
    <div className={square ? "pack-art square" : "pack-art"}>
      {url ? (
        <img src={url} alt="" loading="lazy" />
      ) : (
        <span className="placeholder">{name.replace(/^FTB\s+/i, "").slice(0, 2)}</span>
      )}
    </div>
  );
}

export function PackCard({
  name,
  description,
  artUrl,
  squareArt,
  chips,
  footerLeft,
  footerRight,
  onSelect,
}: {
  name: string;
  description: string;
  artUrl: string | null;
  squareArt?: boolean;
  chips: ReactNode;
  footerLeft: ReactNode;
  footerRight?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="pack-card" onClick={onSelect}>
      <PackArt url={artUrl} name={name} square={squareArt} />
      <div className="pack-body">
        <h3>{name}</h3>
        <p>{description || "No description."}</p>
        <div className="chip-row">{chips}</div>
        <div className="pack-footer">
          <span>{footerLeft}</span>
          {footerRight && <span>{footerRight}</span>}
        </div>
      </div>
    </button>
  );
}
