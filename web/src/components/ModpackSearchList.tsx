import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ftbApi } from "../api/ftb";
import type { ModpackSummary } from "../api/types";

export function ModpackSearchList({ onSelect }: { onSelect: (pack: ModpackSummary) => void }) {
  const [term, setTerm] = useState("");
  const [query, setQuery] = useState("");

  const { data, isFetching, error } = useQuery({
    queryKey: ["ftb-search", query],
    queryFn: () => ftbApi.search(query),
    enabled: query.length > 0,
  });

  return (
    <div className="modpack-search">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(term.trim());
        }}
      >
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search FTB modpacks (e.g. Direwolf20)"
        />
        <button type="submit">Search</button>
      </form>
      {isFetching && <p>Searching...</p>}
      {error && <p className="error-text">Search failed. Try again.</p>}
      <ul className="modpack-results">
        {data?.map((pack) => (
          <li key={pack.id}>
            <button type="button" className="modpack-result" onClick={() => onSelect(pack)}>
              <strong>{pack.name}</strong>
              <span>{pack.synopsis}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
