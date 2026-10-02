import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { curseforgeApi } from "../api/curseforge";
import { errorMessage } from "../api/client";
import type { CfLoader, CfModpackSummary, CfSort } from "../api/types";
import { useDebounced } from "../hooks/useDebounced";
import { formatCount, timeAgo } from "../lib/format";
import { SearchIcon } from "./Icons";
import { PackCard } from "./PackCard";

const SORTS: { value: CfSort; label: string }[] = [
  { value: "popularity", label: "Most popular" },
  { value: "downloads", label: "Most downloads" },
  { value: "updated", label: "Recently updated" },
  { value: "featured", label: "Featured" },
  { value: "name", label: "Name" },
];

/** CurseForge's catalog is huge, so it's searched and paged server-side. */
export function CfPackBrowser({ onSelect }: { onSelect: (pack: CfModpackSummary) => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CfSort>("popularity");
  const [loader, setLoader] = useState<CfLoader | "">("");
  const [gameVersion, setGameVersion] = useState("");
  const debouncedQuery = useDebounced(query);
  const debouncedVersion = useDebounced(gameVersion);
  const versionFilter = /^\d+\.\d+(\.\d+)?$/.test(debouncedVersion) ? debouncedVersion : "";

  const search = useInfiniteQuery({
    queryKey: ["cf-search", debouncedQuery, sort, loader, versionFilter],
    queryFn: ({ pageParam }) =>
      curseforgeApi.search({ query: debouncedQuery, sort, loader, gameVersion: versionFilter, index: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.index + last.pageSize;
      return next < last.totalCount ? next : undefined;
    },
    // Results are reused for a few minutes: CurseForge limits API requests.
    staleTime: 5 * 60 * 1000,
  });

  const packs = search.data?.pages.flatMap((p) => p.packs) ?? [];
  const total = search.data?.pages[0]?.totalCount;

  return (
    <div>
      <div className="toolbar">
        <label className="search">
          <SearchIcon />
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search CurseForge modpacks"
            aria-label="Search CurseForge modpacks"
          />
        </label>
        <input
          className="input"
          value={gameVersion}
          onChange={(e) => setGameVersion(e.target.value.trim())}
          placeholder="MC version, e.g. 1.20.1"
          aria-label="Minecraft version"
          size={18}
        />
        <select className="input" value={loader} onChange={(e) => setLoader(e.target.value as CfLoader | "")} aria-label="Mod loader">
          <option value="">Any loader</option>
          <option value="forge">Forge</option>
          <option value="neoforge">NeoForge</option>
          <option value="fabric">Fabric</option>
          <option value="quilt">Quilt</option>
        </select>
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value as CfSort)} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {total !== undefined && <span className="count">{formatCount(total)} packs</span>}
      </div>

      {search.isLoading && (
        <div className="empty-state">
          <p>Searching CurseForge…</p>
        </div>
      )}
      {search.error && <p className="error-text">{errorMessage(search.error, "CurseForge search failed.")}</p>}
      {search.isSuccess && packs.length === 0 && (
        <div className="empty-state">
          <p>No modpacks found.</p>
        </div>
      )}

      <div className="pack-grid">
        {packs.map((pack) => (
          <PackCard
            key={pack.id}
            name={pack.name}
            description={pack.summary}
            artUrl={pack.logoUrl}
            squareArt
            onSelect={() => onSelect(pack)}
            chips={
              <>
                {pack.minecraftVersions[0] && <span className="chip">{pack.minecraftVersions[0]}</span>}
                {pack.loaders.map((l) => (
                  <span key={l} className="chip">
                    {l}
                  </span>
                ))}
              </>
            }
            footerLeft={`${formatCount(pack.downloads)} downloads`}
            footerRight={pack.updatedAt ? `Updated ${timeAgo(pack.updatedAt)}` : undefined}
          />
        ))}
      </div>

      {search.hasNextPage && (
        <div className="load-more">
          <button className="secondary" onClick={() => search.fetchNextPage()} disabled={search.isFetchingNextPage}>
            {search.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
