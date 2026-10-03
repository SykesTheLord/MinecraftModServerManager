import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ftbApi } from "../api/ftb";
import { curseforgeApi } from "../api/curseforge";
import { errorMessage } from "../api/client";
import type { PackProvider } from "../api/types";
import { formatCount, timeAgo } from "../lib/format";
import { ExternalIcon } from "./Icons";
import { MarkdownLite } from "./MarkdownLite";

const PROVIDER_LABELS: Record<PackProvider, string> = { ftb: "Feed The Beast", curseforge: "CurseForge" };
/** Descriptions longer than this start collapsed. */
const LONG_DESCRIPTION = 700;

/**
 * A modpack's details — art, authors, stats, tags, screenshots and its full
 * description — shown once it's picked, before a version is chosen. Renders
 * at once from what the pack list already knew (`fallback`), then fills in.
 */
export function PackPreviewCard({
  provider,
  packId,
  fallback,
  onChange,
}: {
  provider: PackProvider;
  packId: number;
  fallback: { name: string; summary: string; artUrl: string | null };
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data: preview, isLoading, error } = useQuery({
    queryKey: ["pack-preview", provider, packId],
    queryFn: () => (provider === "ftb" ? ftbApi.preview(packId) : curseforgeApi.preview(packId)),
    staleTime: 10 * 60 * 1000,
  });

  const name = preview?.name ?? fallback.name;
  const artUrl = preview?.artUrl ?? fallback.artUrl;
  const description = preview?.description || preview?.summary || fallback.summary;
  const collapsible = description.length > LONG_DESCRIPTION;

  return (
    <section className="card pack-preview">
      {preview?.bannerUrl && <img className="pack-preview-banner" src={preview.bannerUrl} alt="" />}
      <div className="pack-preview-header">
        {artUrl ? <img className="pack-preview-logo" src={artUrl} alt="" /> : <div className="pack-preview-logo" />}
        <div className="pack-preview-title">
          <h2>{name}</h2>
          <p className="muted">
            {PROVIDER_LABELS[provider]}
            {preview && preview.authors.length > 0 && ` · by ${preview.authors.join(", ")}`}
          </p>
        </div>
        <div className="pack-preview-actions">
          {preview?.websiteUrl && (
            <a className="button-link secondary small" href={preview.websiteUrl} target="_blank" rel="noreferrer noopener">
              View on {provider === "ftb" ? "FTB" : "CurseForge"} <ExternalIcon />
            </a>
          )}
          <button type="button" className="secondary small" onClick={onChange}>
            Change pack
          </button>
        </div>
      </div>

      {preview && (
        <dl className="pack-preview-stats">
          <div>
            <dt>{provider === "ftb" ? "Installs" : "Downloads"}</dt>
            <dd>{formatCount(preview.downloads)}</dd>
          </div>
          {preview.updatedAt && (
            <div>
              <dt>Updated</dt>
              <dd>{timeAgo(preview.updatedAt)}</dd>
            </div>
          )}
          {preview.releasedAt && (
            <div>
              <dt>Released</dt>
              <dd>{new Date(preview.releasedAt).toLocaleDateString()}</dd>
            </div>
          )}
        </dl>
      )}
      {preview && preview.tags.length > 0 && (
        <div className="chip-row pack-preview-tags">
          {preview.tags.map((tag) => (
            <span key={tag} className="chip">
              {tag}
            </span>
          ))}
        </div>
      )}

      {isLoading && (
        <p className="muted pack-preview-loading">
          <span className="spinner" aria-hidden="true" /> Loading details…
        </p>
      )}
      {error && <p className="muted">{errorMessage(error, "Couldn't load this pack's details.")}</p>}

      {description && (
        <div className={collapsible && !expanded ? "pack-preview-description collapsed" : "pack-preview-description"}>
          <MarkdownLite text={description} />
        </div>
      )}
      {collapsible && (
        <button type="button" className="link small" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      {preview && preview.screenshots.length > 0 && (
        <div className="pack-preview-screenshots">
          {preview.screenshots.slice(0, 8).map((shot) => (
            <a key={shot.url} href={shot.url} target="_blank" rel="noreferrer noopener" title={shot.title || "Screenshot"}>
              <img src={shot.thumbnailUrl} alt={shot.title || "Screenshot"} loading="lazy" />
            </a>
          ))}
        </div>
      )}

      {preview && preview.links.length > 0 && (
        <p className="pack-preview-links">
          {preview.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener">
              {link.name} <ExternalIcon />
            </a>
          ))}
        </p>
      )}
    </section>
  );
}
