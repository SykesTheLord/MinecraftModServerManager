import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ftbApi } from "../api/ftb";
import { errorMessage } from "../api/client";
import type { ModpackSummary } from "../api/types";
import { formatCount, timeAgo } from "../lib/format";
import { SearchIcon } from "./Icons";
import { PackCard } from "./PackCard";

type Sort = "popular" | "updated" | "name";

/** The whole FTB catalog (it's small), filtered and sorted locally. */
export function FtbPackBrowser({ onSelect }: { onSelect: (pack: ModpackSummary) => void }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("popular");
  const [mcVersion, setMcVersion] = useState("");

  const { data: packs, isLoading, error } = useQuery({ queryKey: ["ftb-modpacks"], queryFn: ftbApi.list, staleTime: 10 * 60 * 1000 });

  const mcVersions = useMemo(
    () =>
      [...new Set((packs ?? []).map((p) => p.minecraftVersion).filter((v): v is string => Boolean(v)))].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true })
      ),
    [packs]
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (packs ?? []).filter(
      (p) =>
        (!mcVersion || p.minecraftVersion === mcVersion) &&
        (!needle ||
          p.name.toLowerCase().includes(needle) ||
          p.synopsis.toLowerCase().includes(needle) ||
          p.tags.some((t) => t.toLowerCase().includes(needle)))
    );
    const sorted = [...matches];
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "updated") sorted.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    else sorted.sort((a, b) => Number(b.featured) - Number(a.featured) || b.installs - a.installs);
    return sorted;
  }, [packs, filter, sort, mcVersion]);

  return (
    <div>
      <div className="toolbar">
        <label className="search">
          <SearchIcon />
          <input
            className="input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, tag or description"
            aria-label="Filter modpacks"
          />
        </label>
        <select className="input" value={mcVersion} onChange={(e) => setMcVersion(e.target.value)} aria-label="Minecraft version">
          <option value="">All versions</option>
          {mcVersions.map((v) => (
            <option key={v} value={v}>
              Minecraft {v}
            </option>
          ))}
        </select>
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="popular">Most popular</option>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
        </select>
        {packs && <span className="count">{visible.length === packs.length ? `${packs.length} packs` : `${visible.length} of ${packs.length}`}</span>}
      </div>

      {isLoading && (
        <div className="empty-state">
          <p>Loading the FTB catalog…</p>
        </div>
      )}
      {error && <p className="error-text">{errorMessage(error, "Couldn't load the FTB catalog.")}</p>}
      {packs && visible.length === 0 && (
        <div className="empty-state">
          <p>No packs match that filter.</p>
        </div>
      )}

      <div className="pack-grid">
        {visible.map((pack) => (
          <PackCard
            key={pack.id}
            name={pack.name}
            description={pack.synopsis}
            artUrl={pack.artUrl}
            squareArt
            onSelect={() => onSelect(pack)}
            chips={
              <>
                {pack.featured && <span className="chip accent">Featured</span>}
                {pack.minecraftVersion && <span className="chip">{pack.minecraftVersion}</span>}
                {pack.loader && <span className="chip">{pack.loader}</span>}
              </>
            }
            footerLeft={`${formatCount(pack.installs)} installs`}
            footerRight={pack.updatedAt ? `Updated ${timeAgo(pack.updatedAt)}` : undefined}
          />
        ))}
      </div>
    </div>
  );
}
