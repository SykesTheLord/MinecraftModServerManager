import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { curseforgeApi } from "../api/curseforge";
import { errorMessage } from "../api/client";
import type { PackProvider } from "../api/types";
import { loadPackVersions } from "../lib/packVersions";
import { FtbPackBrowser } from "./FtbPackBrowser";
import { CfPackBrowser } from "./CfPackBrowser";
import { Tabs } from "./Tabs";

/** A modpack and the version of it a server runs. */
export interface PickedPack {
  provider: PackProvider;
  packId: number;
  packName: string;
  artUrl: string | null;
  versionId: number;
  versionName: string;
  minecraftVersion: string | null;
}

interface StagedPack {
  provider: PackProvider;
  packId: number;
  packName: string;
  artUrl: string | null;
}

/**
 * Picks the modpack (FTB, or CurseForge when configured) an existing server
 * is, and which version of it. Keep it outside any <form>: the pack browsers'
 * search fields would otherwise submit it on Enter.
 */
export function PackPicker({
  value,
  onChange,
  expectedMinecraftVersion,
}: {
  value: PickedPack | null;
  onChange: (pack: PickedPack | null) => void;
  /** The Minecraft version the server is known to run: versions for it are suggested first. */
  expectedMinecraftVersion?: string | null;
}) {
  const [provider, setProvider] = useState<PackProvider>("ftb");
  const [staged, setStaged] = useState<StagedPack | null>(null);
  const [versionId, setVersionId] = useState<number | null>(null);
  const { data: cfStatus } = useQuery({ queryKey: ["cf-status"], queryFn: curseforgeApi.status });

  const { data: versions, isLoading, error } = useQuery({
    queryKey: ["pack-versions", staged?.provider, staged?.packId],
    queryFn: () => loadPackVersions(staged!.provider, staged!.packId),
    enabled: Boolean(staged),
    staleTime: 5 * 60 * 1000,
  });
  // Until one is chosen, suggest the newest version for the server's Minecraft version (else the newest).
  const suggested = versions?.find((v) => expectedMinecraftVersion && v.minecraftVersion === expectedMinecraftVersion) ?? versions?.[0];
  const selected = versions?.find((v) => v.id === versionId) ?? suggested;
  const mismatch =
    selected && expectedMinecraftVersion && selected.minecraftVersion && selected.minecraftVersion !== expectedMinecraftVersion;

  if (value) {
    return (
      <div className="picked-pack">
        {value.artUrl ? <img src={value.artUrl} alt="" /> : <div className="thumb-placeholder" />}
        <div>
          <strong>{value.packName}</strong>
          <span className="muted">
            {value.versionName}
            {value.minecraftVersion ? ` · Minecraft ${value.minecraftVersion}` : ""} ·{" "}
            {value.provider === "ftb" ? "Feed The Beast" : "CurseForge"}
          </span>
        </div>
        <button type="button" className="secondary small" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }

  if (staged) {
    return (
      <div className="pack-picker-version">
        <div className="picked-pack">
          {staged.artUrl ? <img src={staged.artUrl} alt="" /> : <div className="thumb-placeholder" />}
          <div>
            <strong>{staged.packName}</strong>
            <span className="muted">Which version does the server run?</span>
          </div>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              setStaged(null);
              setVersionId(null);
            }}
          >
            Other pack
          </button>
        </div>
        {isLoading && <p className="muted">Loading versions…</p>}
        {error && <p className="error-text">{errorMessage(error, "Couldn't load versions.")}</p>}
        {versions?.length === 0 && <p className="muted">This pack has no versions to pick from.</p>}
        {versions && versions.length > 0 && selected && (
          <>
            <label className="field">
              Version
              <select className="input" value={selected.id} onChange={(e) => setVersionId(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.minecraftVersion ? ` — Minecraft ${v.minecraftVersion}` : ""}
                    {v.type !== "release" ? ` (${v.type})` : ""}
                  </option>
                ))}
              </select>
            </label>
            {mismatch && (
              <p className="callout warning">
                The server runs Minecraft {expectedMinecraftVersion}, but this version is for {selected.minecraftVersion}. Pick the
                version the server actually has installed.
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...staged,
                    versionId: selected.id,
                    versionName: selected.name,
                    minecraftVersion: selected.minecraftVersion,
                  })
                }
              >
                Use {selected.name}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="pack-picker">
      <Tabs
        label="Modpack source"
        value={provider}
        onChange={setProvider}
        options={[
          { value: "ftb", label: "Feed The Beast" },
          ...(cfStatus?.configured ? [{ value: "curseforge" as const, label: "CurseForge" }] : []),
        ]}
      />
      {provider === "ftb" ? (
        <FtbPackBrowser onSelect={(p) => setStaged({ provider: "ftb", packId: p.id, packName: p.name, artUrl: p.artUrl })} />
      ) : (
        <CfPackBrowser
          onSelect={(p) => setStaged({ provider: "curseforge", packId: p.id, packName: p.name, artUrl: p.logoUrl })}
        />
      )}
    </div>
  );
}
