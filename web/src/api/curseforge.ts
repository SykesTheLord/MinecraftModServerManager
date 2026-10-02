import { api } from "./client";
import type { CfFileSummary, CfLoader, CfModpackSummary, CfSort } from "./types";

export interface CfSearchParams {
  query: string;
  sort: CfSort;
  gameVersion: string;
  loader: CfLoader | "";
  index: number;
}

export interface CfSearchPage {
  packs: CfModpackSummary[];
  totalCount: number;
  index: number;
  pageSize: number;
}

export const curseforgeApi = {
  status: () => api.get<{ configured: boolean }>("/curseforge/status"),
  search: (params: CfSearchParams) => {
    const qs = new URLSearchParams({ sort: params.sort, index: String(params.index) });
    if (params.query.trim()) qs.set("query", params.query.trim());
    if (params.gameVersion) qs.set("gameVersion", params.gameVersion);
    if (params.loader) qs.set("loader", params.loader);
    return api.get<CfSearchPage>(`/curseforge/modpacks?${qs}`);
  },
  /** `refresh`: force the list to be fetched from CurseForge again (otherwise reused for 12 hours). */
  files: (modId: number, refresh = false) =>
    api.get<CfFileSummary[]>(`/curseforge/modpacks/${modId}/files${refresh ? "?refresh=1" : ""}`),
};
