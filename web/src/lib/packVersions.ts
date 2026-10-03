import { ftbApi } from "../api/ftb";
import { curseforgeApi } from "../api/curseforge";
import type { PackProvider } from "../api/types";

/** A pack version, normalized across FTB versions and CurseForge files. Newest first. */
export interface PackVersion {
  id: number;
  name: string;
  type: string;
  date: string | number | null;
  minecraftVersion: string | null;
  loader: string | null;
  recommendedMemoryMb: number | null;
}

/** `refresh`: bypass the manager's 12-hour cache of CurseForge version lists (FTB's are always live). */
export async function loadPackVersions(provider: PackProvider, packId: number, refresh = false): Promise<PackVersion[]> {
  if (provider === "ftb") {
    return (await ftbApi.versions(packId)).map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      date: v.updatedAt,
      minecraftVersion: v.minecraftVersion,
      loader: v.loader,
      recommendedMemoryMb: v.recommendedMemoryMb,
    }));
  }
  return (await curseforgeApi.files(packId, refresh)).map((f) => ({
    id: f.id,
    name: f.displayName,
    type: f.releaseType,
    date: f.date,
    minecraftVersion: f.minecraftVersion,
    loader: f.loaders.join(", ") || null,
    recommendedMemoryMb: null,
  }));
}
