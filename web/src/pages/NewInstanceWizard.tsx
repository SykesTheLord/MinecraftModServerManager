import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ftbApi } from "../api/ftb";
import { curseforgeApi } from "../api/curseforge";
import { instancesApi } from "../api/instances";
import { errorMessage } from "../api/client";
import type { CfModpackSummary, ModpackSummary } from "../api/types";
import { Layout } from "../components/Layout";
import { PageHeader } from "../components/PageHeader";
import { FtbPackBrowser } from "../components/FtbPackBrowser";
import { CfPackBrowser } from "../components/CfPackBrowser";
import { ExternalIcon } from "../components/Icons";
import { Tabs } from "../components/Tabs";
import { useBaseDomain } from "../hooks/useBaseDomain";
import { formatMemory, slugify, SUBDOMAIN_HINT, SUBDOMAIN_PATTERN, timeAgo } from "../lib/format";

type Source = "ftb" | "curseforge";

interface SelectedPack {
  source: Source;
  id: number;
  name: string;
  description: string;
  artUrl: string | null;
  websiteUrl: string | null;
}

/** A pack version, normalized across FTB versions and CurseForge files. */
interface PackVersion {
  id: number;
  name: string;
  type: string;
  date: string | number | null;
  minecraftVersion: string | null;
  loader: string | null;
  recommendedMemoryMb: number | null;
}

const MEMORY_OPTIONS = [2048, 3072, 4096, 6144, 8192, 10240, 12288, 16384];
// Mirrors server/src/docker/javaImage.ts KNOWN_JAVA_VERSIONS (validated server-side).
const JAVA_VERSIONS = [8, 11, 16, 17, 21, 25];

function fromFtb(pack: ModpackSummary): SelectedPack {
  return { source: "ftb", id: pack.id, name: pack.name, description: pack.synopsis, artUrl: pack.artUrl, websiteUrl: null };
}

function fromCf(pack: CfModpackSummary): SelectedPack {
  return {
    source: "curseforge",
    id: pack.id,
    name: pack.name,
    description: pack.summary,
    artUrl: pack.logoUrl,
    websiteUrl: pack.websiteUrl,
  };
}

export function NewInstanceWizard() {
  const [source, setSource] = useState<Source>("ftb");
  const [pack, setPack] = useState<SelectedPack | null>(null);
  const [version, setVersion] = useState<PackVersion | null>(null);
  const step = !pack ? 1 : !version ? 2 : 3;

  return (
    <Layout title="New server">
      <Link to="/" className="back-link">
        ← Servers
      </Link>
      <PageHeader
        title="New server"
        subtitle="Deploy a modpack from FTB or CurseForge. It gets its own container and subdomain."
        actions={
          <Link to="/instances/import" className="button-link secondary">
            Import an existing server
          </Link>
        }
      />

      {/* Finished steps are links back to them. */}
      <ol className="stepper" aria-label="Steps">
        <li className={step === 1 ? "current" : "done"} aria-current={step === 1 ? "step" : undefined}>
          {step > 1 ? (
            <button type="button" className="stepper-link" onClick={() => { setPack(null); setVersion(null); }}>
              {pack?.name}
            </button>
          ) : (
            <span>Choose a modpack</span>
          )}
        </li>
        <li className={step === 2 ? "current" : step > 2 ? "done" : ""} aria-current={step === 2 ? "step" : undefined}>
          {step > 2 ? (
            <button type="button" className="stepper-link" onClick={() => setVersion(null)}>
              {version?.name}
            </button>
          ) : (
            <span>Pick a version</span>
          )}
        </li>
        <li className={step === 3 ? "current" : ""} aria-current={step === 3 ? "step" : undefined}>
          <span>Configure & deploy</span>
        </li>
      </ol>

      {step === 1 && (
        <>
          <Tabs
            label="Modpack source"
            value={source}
            onChange={setSource}
            options={[
              { value: "ftb", label: "Feed The Beast" },
              { value: "curseforge", label: "CurseForge" },
            ]}
          />
          {source === "ftb" ? (
            <FtbPackBrowser onSelect={(p) => setPack(fromFtb(p))} />
          ) : (
            <CurseForgeSource onSelect={(p) => setPack(fromCf(p))} />
          )}
        </>
      )}

      {pack && (
        <SelectedPackHeader
          pack={pack}
          onChange={() => {
            setPack(null);
            setVersion(null);
          }}
        />
      )}

      {step === 2 && pack && <VersionStep pack={pack} onSelect={setVersion} />}
      {step === 3 && pack && version && <ConfigureStep pack={pack} version={version} onBack={() => setVersion(null)} />}
    </Layout>
  );
}

function CurseForgeSource({ onSelect }: { onSelect: (pack: CfModpackSummary) => void }) {
  const { data: status, isLoading } = useQuery({ queryKey: ["cf-status"], queryFn: curseforgeApi.status });
  if (isLoading) {
    return (
      <div className="page-loading">
        <span className="spinner" aria-label="Loading" />
      </div>
    );
  }
  if (!status?.configured) {
    return (
      <div className="empty-state">
        <h2>CurseForge isn't set up</h2>
        <p>
          CurseForge's API needs a key. Get a free one at{" "}
          <a href="https://console.curseforge.com/" target="_blank" rel="noreferrer">
            console.curseforge.com
          </a>
          , set <code>CF_API_KEY</code> in <code>.env</code>, and re-run <code>./scripts/apply.sh</code>.
        </p>
        <p className="muted">The key stays with the manager — modpack servers never see it.</p>
      </div>
    );
  }
  return <CfPackBrowser onSelect={onSelect} />;
}

function SelectedPackHeader({ pack, onChange }: { pack: SelectedPack; onChange: () => void }) {
  return (
    <div className="card selected-pack">
      {pack.artUrl ? <img src={pack.artUrl} alt="" /> : <div className="thumb-placeholder" />}
      <div>
        <h2>{pack.name}</h2>
        <p>
          {pack.source === "ftb" ? "Feed The Beast" : "CurseForge"}
          {pack.websiteUrl && (
            <>
              {" · "}
              <a href={pack.websiteUrl} target="_blank" rel="noreferrer">
                View on CurseForge <ExternalIcon />
              </a>
            </>
          )}
        </p>
      </div>
      <button className="secondary small spacer" onClick={onChange}>
        Change pack
      </button>
    </div>
  );
}

function VersionStep({ pack, onSelect }: { pack: SelectedPack; onSelect: (v: PackVersion) => void }) {
  const { data: versions, isLoading, error } = useQuery({
    queryKey: ["pack-versions", pack.source, pack.id],
    queryFn: async (): Promise<PackVersion[]> => {
      if (pack.source === "ftb") {
        return (await ftbApi.versions(pack.id)).map((v) => ({
          id: v.id,
          name: v.name,
          type: v.type,
          date: v.updatedAt,
          minecraftVersion: v.minecraftVersion,
          loader: v.loader,
          recommendedMemoryMb: v.recommendedMemoryMb,
        }));
      }
      return (await curseforgeApi.files(pack.id)).map((f) => ({
        id: f.id,
        name: f.displayName,
        type: f.releaseType,
        date: f.date,
        minecraftVersion: f.minecraftVersion,
        loader: f.loaders.join(", ") || null,
        recommendedMemoryMb: null,
      }));
    },
  });

  return (
    <section className="card">
      <div className="card-header">
        <h2>Pick a version</h2>
        {versions && <span className="muted">{versions.length} available · newest first</span>}
      </div>
      {isLoading && <p className="muted">Loading versions…</p>}
      {error && <p className="error-text">{errorMessage(error, "Couldn't load versions.")}</p>}
      {versions?.length === 0 && <p className="muted">This pack has no deployable versions.</p>}
      {versions && versions.length > 0 && (
        <ul className="version-list">
          {versions.map((v) => (
            <li key={v.id}>
              <button type="button" className="version-row" onClick={() => onSelect(v)}>
                <span>
                  <span className="name">{v.name}</span>
                  <span className="sub">{v.date ? timeAgo(v.date) : "—"}</span>
                </span>
                <span className="hide-sm">{v.minecraftVersion ? `Minecraft ${v.minecraftVersion}` : "—"}</span>
                <span className="hide-sm muted">{v.loader ?? "—"}</span>
                <span>
                  {v.type === "release" ? (
                    <span className="chip accent">Release</span>
                  ) : (
                    <span className={v.type === "alpha" ? "chip danger" : "chip warning"}>{v.type}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConfigureStep({ pack, version, onBack }: { pack: SelectedPack; version: PackVersion; onBack: () => void }) {
  const navigate = useNavigate();
  const baseDomain = useBaseDomain();
  const [name, setName] = useState(pack.name);
  const [subdomain, setSubdomain] = useState(slugify(pack.name));
  const [memoryMb, setMemoryMb] = useState(version.recommendedMemoryMb ?? 6144);
  const [javaVersion, setJavaVersion] = useState<number | null>(null);

  const memoryOptions = MEMORY_OPTIONS.includes(memoryMb) ? MEMORY_OPTIONS : [...MEMORY_OPTIONS, memoryMb].sort((a, b) => a - b);
  const address = `${subdomain || "…"}.${baseDomain ?? "…"}`;

  const create = useMutation({
    mutationFn: () =>
      pack.source === "ftb"
        ? instancesApi.create({
            name,
            subdomain,
            ftbModpackId: pack.id,
            ftbVersionId: version.id,
            ftbPackName: `${pack.name} (${version.name})`,
            memoryMb,
          })
        : instancesApi.createCurseForge({ name, subdomain, modId: pack.id, fileId: version.id, memoryMb, javaVersion }),
    onSuccess: (instance) => navigate(`/instances/${instance.id}`),
  });

  return (
    <div className="two-col">
      <section className="card">
        <h2>Configure</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Display name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Subdomain
            <div className="subdomain-input">
              <input
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                pattern={SUBDOMAIN_PATTERN}
                title={SUBDOMAIN_HINT}
                spellCheck={false}
                required
              />
              <span>.{baseDomain ?? "…"}</span>
            </div>
          </label>
          <div className="form-row">
            <label>
              Memory
              <select value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))}>
                {memoryOptions.map((mb) => (
                  <option key={mb} value={mb}>
                    {formatMemory(mb)}
                    {mb === version.recommendedMemoryMb ? " (recommended)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {pack.source === "curseforge" && (
              <label>
                Java
                <select value={javaVersion ?? ""} onChange={(e) => setJavaVersion(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Automatic (from Minecraft {version.minecraftVersion ?? "version"})</option>
                  {JAVA_VERSIONS.map((v) => (
                    <option key={v} value={v}>
                      Java {v}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {pack.source === "curseforge" && (
            <div className="callout info">
              <p>
                The pack is downloaded and installed in a separate, short-lived container that holds your CurseForge key
                — the server itself never sees it. If some mod authors only allow downloads from CurseForge's website,
                the server page will list those files for you to upload.
              </p>
            </div>
          )}

          {create.isError && <p className="error-text">{errorMessage(create.error, "Failed to create the server.")}</p>}
          <div className="form-actions">
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? "Deploying…" : "Deploy server"}
            </button>
            <button type="button" className="secondary" onClick={onBack}>
              Back
            </button>
          </div>
        </form>
      </section>

      <aside className="card summary">
        <h2>Summary</h2>
        <dl>
          <div>
            <dt>Pack</dt>
            <dd>{pack.name}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{version.name}</dd>
          </div>
          <div>
            <dt>Minecraft</dt>
            <dd>{version.minecraftVersion ?? "—"}</dd>
          </div>
          <div>
            <dt>Loader</dt>
            <dd>{version.loader ?? "—"}</dd>
          </div>
          <div>
            <dt>Memory</dt>
            <dd>{formatMemory(memoryMb)}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>
              <code>{address}</code>
            </dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
