import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ftbApi } from "../api/ftb";
import { instancesApi } from "../api/instances";
import { settingsApi } from "../api/settings";
import { ApiError } from "../api/client";
import { ModpackSearchList } from "../components/ModpackSearchList";
import { Layout } from "../components/Layout";
import type { ModpackSummary, ModpackVersionSummary } from "../api/types";

const MEMORY_OPTIONS = [2048, 4096, 6144, 8192, 12288];

export function NewInstanceWizard() {
  const navigate = useNavigate();
  const [pack, setPack] = useState<ModpackSummary | null>(null);
  const [version, setVersion] = useState<ModpackVersionSummary | null>(null);
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [memoryMb, setMemoryMb] = useState(4096);

  const { data: baseDomain } = useQuery({ queryKey: ["base-domain"], queryFn: settingsApi.baseDomain });
  const { data: versions, isFetching: loadingVersions } = useQuery({
    queryKey: ["ftb-versions", pack?.id],
    queryFn: () => ftbApi.versions(pack!.id),
    enabled: !!pack,
  });

  const create = useMutation({
    mutationFn: () =>
      instancesApi.create({
        name,
        subdomain,
        ftbModpackId: pack!.id,
        ftbVersionId: version!.id,
        ftbPackName: `${pack!.name} (${version!.name})`,
        memoryMb,
      }),
    onSuccess: (instance) => navigate(`/instances/${instance.id}`),
  });

  return (
    <Layout>
      <h1>New Instance</h1>

      {!pack && (
        <section className="card">
          <h2>1. Choose a modpack</h2>
          <ModpackSearchList onSelect={setPack} />
        </section>
      )}

      {pack && !version && (
        <section className="card">
          <h2>2. Choose a version</h2>
          <p>
            {pack.name} <button onClick={() => setPack(null)}>Change</button>
          </p>
          {loadingVersions && <p>Loading versions...</p>}
          <ul className="version-list">
            {versions?.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => setVersion(v)}>
                  {v.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pack && version && (
        <section className="card">
          <h2>3. Configure</h2>
          <p>
            {pack.name} — {version.name} <button onClick={() => setVersion(null)}>Change</button>
          </p>
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
                  required
                />
                <span>.{baseDomain?.baseDomain ?? "..."}</span>
              </div>
            </label>
            <label>
              Memory
              <select value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))}>
                {MEMORY_OPTIONS.map((mb) => (
                  <option key={mb} value={mb}>
                    {mb} MB
                  </option>
                ))}
              </select>
            </label>
            {create.isError && (
              <p className="error-text">
                {create.error instanceof ApiError ? create.error.message : "Failed to create instance."}
              </p>
            )}
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? "Deploying..." : "Deploy"}
            </button>
          </form>
        </section>
      )}
    </Layout>
  );
}
