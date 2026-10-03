import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instancesApi } from "../api/instances";
import type { Instance, MissingFileDetail } from "../api/types";
import { Layout } from "../components/Layout";
import { SourceChip, StatusBadge } from "../components/StatusBadge";
import { ConsoleView } from "../components/ConsoleView";
import { ServerPropertiesEditor } from "../components/ServerPropertiesEditor";
import { PackUpdatesPanel } from "../components/PackUpdatesPanel";
import { BackupsPanel } from "../components/BackupsPanel";
import { CopyButton } from "../components/CopyButton";
import { ExternalIcon } from "../components/Icons";
import { Tabs } from "../components/Tabs";
import { errorMessage, latestMutationError } from "../api/client";
import { useBaseDomain } from "../hooks/useBaseDomain";
import { formatMemory, SUBDOMAIN_HINT, SUBDOMAIN_PATTERN, timeAgo } from "../lib/format";

type Tab = "console" | "properties" | "updates" | "backups";

export function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const baseDomain = useBaseDomain();
  const [subdomainDraft, setSubdomainDraft] = useState<string | null>(null);
  const [deleteWorldData, setDeleteWorldData] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [requestedTab, setTab] = useState<Tab>("console");

  const { data: instance, isLoading, error } = useQuery({
    queryKey: ["instance", id],
    queryFn: () => instancesApi.get(id!),
    refetchInterval: (query) => (query.state.data?.status === "creating" ? 2000 : 5000),
    retry: false,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["instance", id] });
    queryClient.invalidateQueries({ queryKey: ["instances"] });
  };

  const start = useMutation({ mutationFn: () => instancesApi.start(id!), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => instancesApi.stop(id!), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => instancesApi.restart(id!), onSuccess: invalidate });
  const updateSubdomain = useMutation({
    mutationFn: (subdomain: string) => instancesApi.updateSubdomain(id!, subdomain),
    onSuccess: () => {
      setSubdomainDraft(null);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => instancesApi.remove(id!, deleteWorldData),
    onSuccess: () => navigate("/"),
  });

  if (!instance) {
    return (
      <Layout title="Server">
        <Link to="/" className="back-link">
          ← Servers
        </Link>
        {isLoading || !error ? (
          <div className="page-loading">
            <span className="spinner" aria-label="Loading" />
          </div>
        ) : (
          <div className="empty-state">
            <h2>Couldn't open this server</h2>
            <p>{errorMessage(error, "Failed to load this server.")}</p>
          </div>
        )}
      </Layout>
    );
  }

  const canOperate = instance.effectiveRole === "admin" || instance.effectiveRole === "operator";
  const canAdmin = instance.effectiveRole === "admin";
  const isRunning = instance.status === "running" || instance.status === "installing";
  const isStopping = instance.status === "stopping";
  const hasServer = Boolean(instance.container_id);
  const cfInstallPending = instance.source === "curseforge" && !hasServer;
  const canUpdate = canAdmin && (instance.source === "ftb" || instance.source === "curseforge");
  // Without a server container there's no console; land on a tab that still works.
  const tab = requestedTab === "console" && !hasServer ? (canUpdate ? "updates" : "backups") : requestedTab;
  const actionError = latestMutationError(start, stop, restart, updateSubdomain, remove);
  const address = baseDomain ? `${instance.subdomain}.${baseDomain}` : instance.subdomain;
  // Wiping the world can't be undone, so that path asks for the server's name first.
  const deleteBlocked = deleteWorldData && deleteConfirmName.trim() !== instance.name;
  const cancelDelete = () => {
    setConfirmingDelete(false);
    setDeleteWorldData(false);
    setDeleteConfirmName("");
  };

  const tabs: { value: Tab; label: string }[] = [
    ...(hasServer ? [{ value: "console" as const, label: "Console" }] : []),
    ...(canAdmin && hasServer ? [{ value: "properties" as const, label: "Server properties" }] : []),
    ...(canUpdate ? [{ value: "updates" as const, label: instance.available_version_id ? "Updates •" : "Updates" }] : []),
    ...(canAdmin ? [{ value: "backups" as const, label: "Backups" }] : []),
  ];

  return (
    <Layout title={instance.name}>
      <Link to="/" className="back-link">
        ← Servers
      </Link>
      <div className="page-header">
        <div>
          <h1>
            {instance.name} <StatusBadge status={instance.status} />
          </h1>
          <p>{instance.ftb_pack_name}</p>
        </div>
        {canOperate && hasServer && (
          <div className="page-header-actions">
            {isStopping ? (
              <button className="secondary" disabled title="The server is saving and shutting down; this takes up to a minute.">
                Stopping…
              </button>
            ) : isRunning ? (
              <>
                <button className="secondary" onClick={() => stop.mutate()} disabled={stop.isPending}>
                  Stop
                </button>
                <button className="secondary" onClick={() => restart.mutate()} disabled={restart.isPending}>
                  Restart
                </button>
              </>
            ) : (
              <button onClick={() => start.mutate()} disabled={start.isPending}>
                Start
              </button>
            )}
          </div>
        )}
      </div>
      {actionError != null && <p className="error-text">{errorMessage(actionError, "Action failed.")}</p>}

      <section className="card">
        <dl className="detail-grid">
          <div>
            <dt>Address</dt>
            <dd>
              {subdomainDraft === null ? (
                <>
                  <code>{address}</code>
                  <CopyButton text={address} />
                  {canAdmin && (
                    <button className="link small" onClick={() => setSubdomainDraft(instance.subdomain)}>
                      Edit
                    </button>
                  )}
                </>
              ) : (
                <form
                  className="subdomain-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (subdomainDraft === instance.subdomain) setSubdomainDraft(null);
                    else updateSubdomain.mutate(subdomainDraft);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSubdomainDraft(null);
                  }}
                >
                  <input
                    value={subdomainDraft}
                    onChange={(e) => setSubdomainDraft(e.target.value.toLowerCase())}
                    pattern={SUBDOMAIN_PATTERN}
                    title={SUBDOMAIN_HINT}
                    aria-label="Subdomain"
                    autoFocus
                    required
                  />
                  <button type="submit" className="small" disabled={updateSubdomain.isPending}>
                    {updateSubdomain.isPending ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="secondary small" onClick={() => setSubdomainDraft(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              <SourceChip source={instance.source} />
            </dd>
          </div>
          <div>
            <dt>Memory</dt>
            <dd>{formatMemory(instance.memory_mb)}</dd>
          </div>
          <div>
            <dt>Runtime image</dt>
            <dd>
              <code>{instance.image}</code>
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{timeAgo(instance.created_at)}</dd>
          </div>
        </dl>
        {instance.status === "error" && instance.last_error && hasServer && (
          <pre className="instance-error-log">{instance.last_error}</pre>
        )}
      </section>

      {cfInstallPending && (
        <CurseForgeInstallPanel instance={instance} canManage={canAdmin} onChange={invalidate} />
      )}

      {canOperate && (hasServer || canAdmin) && (
        <section className="card">
          <Tabs label="Server tools" value={tab} onChange={setTab} options={tabs} />
          {tab === "console" && hasServer && (
            // Keyed on the container so the console reconnects once a container exists.
            <ConsoleView key={instance.container_id ?? "none"} instanceId={instance.id} />
          )}
          {tab === "properties" && canAdmin && hasServer && <ServerPropertiesEditor instanceId={instance.id} running={isRunning} />}
          {tab === "updates" && canUpdate && <PackUpdatesPanel instance={instance} />}
          {tab === "backups" && canAdmin && <BackupsPanel instance={instance} />}
        </section>
      )}

      {canAdmin && (
        <section className="card danger-zone">
          <div className="card-header">
            <div>
              <h2>Danger zone</h2>
              <p className="muted">
                Deleting removes the container and its route. The world and files are kept unless you choose otherwise.
              </p>
            </div>
            {!confirmingDelete && (
              <button className="danger" onClick={() => setConfirmingDelete(true)}>
                Delete server…
              </button>
            )}
          </div>
          {confirmingDelete && (
            <form
              className="delete-confirm"
              onSubmit={(e) => {
                e.preventDefault();
                if (!deleteBlocked) remove.mutate();
              }}
            >
              <label className="checkbox">
                <input type="checkbox" checked={deleteWorldData} onChange={(e) => setDeleteWorldData(e.target.checked)} />
                <span>Also permanently delete its world and files (no backup is kept)</span>
              </label>
              {deleteWorldData && (
                <label>
                  Type <strong>{instance.name}</strong> to confirm
                  <input
                    value={deleteConfirmName}
                    onChange={(e) => setDeleteConfirmName(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                  />
                </label>
              )}
              <div className="form-actions">
                <button type="submit" className="danger" disabled={remove.isPending || deleteBlocked}>
                  {remove.isPending ? "Deleting…" : deleteWorldData ? "Delete server and world" : "Delete server"}
                </button>
                <button type="button" className="secondary" onClick={cancelDelete} disabled={remove.isPending}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}
    </Layout>
  );
}

/**
 * A CurseForge pack whose server doesn't exist yet: installing, blocked on
 * files the admin has to fetch from CurseForge's site, or failed. The server's
 * admins can retry and upload (a version update they started can land here).
 */
function CurseForgeInstallPanel({ instance, canManage, onChange }: { instance: Instance; canManage: boolean; onChange: () => void }) {
  const installing = instance.status === "creating" || instance.installRunning;
  const { data: log } = useQuery({
    queryKey: ["instance-log", instance.id],
    queryFn: () => instancesApi.recentLogs(instance.id),
    refetchInterval: installing ? 2000 : false,
  });

  const awaiting = instance.status === "awaiting_files" && !installing;
  // Names and download links come from CurseForge rather than the database, so they're fetched once
  // here instead of with every poll of the instance (CurseForge limits API requests).
  const queryClient = useQueryClient();
  const missingFilesKey = ["cf-missing-files", instance.id];
  const { data: missingFiles, error: missingFilesError } = useQuery({
    queryKey: missingFilesKey,
    queryFn: () => instancesApi.missingFiles(instance.id),
    enabled: awaiting,
    staleTime: 5 * 60 * 1000,
  });
  const onUploaded = () => {
    onChange();
    void queryClient.invalidateQueries({ queryKey: missingFilesKey });
  };

  const retry = useMutation({ mutationFn: () => instancesApi.retryCurseForgeInstall(instance.id), onSuccess: onChange });
  const allUploaded = instance.missingFiles.length > 0 && instance.missingFiles.every((f) => f.uploaded);

  return (
    <section className="card">
      <div className="card-header">
        <h2>Modpack install</h2>
        {installing && <span className="spinner" aria-label="Installing" />}
      </div>

      {installing && (
        <div className="callout info">
          <p>
            Downloading the pack and its mods and installing the mod loader. Large packs take a few minutes. The server
            starts automatically when this finishes.
          </p>
        </div>
      )}

      {instance.status === "awaiting_files" && !installing && (
        <>
          <div className="callout warning">
            <div>
              <p>
                <strong>
                  {instance.missingFiles.length} file{instance.missingFiles.length === 1 ? "" : "s"} can't be downloaded
                  automatically.
                </strong>{" "}
                Their authors only allow downloads from CurseForge's website. Download each one from its link, then upload
                it here (each is checked against CurseForge's checksum).
              </p>
            </div>
          </div>
          {missingFilesError != null && (
            <p className="error-text">
              {errorMessage(missingFilesError, "Couldn't look these files up on CurseForge.")} Their file names are listed below.
            </p>
          )}
          {!missingFiles && !missingFilesError ? (
            <div className="page-loading">
              <span className="spinner" aria-label="Loading" />
            </div>
          ) : (
            <ul className="checklist">
              {instance.missingFiles.map((file) => (
                <MissingFileRow
                  key={file.fileId}
                  instanceId={instance.id}
                  file={file}
                  detail={missingFiles?.find((d) => d.fileId === file.fileId)}
                  canManage={canManage}
                  onUploaded={onUploaded}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {instance.status === "error" && !installing && instance.last_error && (
        <pre className="instance-error-log">{instance.last_error}</pre>
      )}

      {canManage && !installing && (instance.status === "awaiting_files" || instance.status === "error") && (
        <div className="form-actions">
          <button onClick={() => retry.mutate()} disabled={retry.isPending}>
            {instance.status === "awaiting_files" ? (allUploaded ? "Continue install" : "Retry install") : "Retry install"}
          </button>
          {retry.isError && <span className="error-text">{errorMessage(retry.error, "Couldn't restart the install.")}</span>}
        </div>
      )}

      {log && (
        <details open={installing}>
          <summary className="muted">Install log</summary>
          <div className="console-log" role="log">
            {log
              .split("\n")
              .slice(-150)
              .map((line, i) => (
                <div key={i} className="console-line">
                  {line}
                </div>
              ))}
          </div>
        </details>
      )}
    </section>
  );
}

function MissingFileRow({
  instanceId,
  file,
  detail,
  canManage,
  onUploaded,
}: {
  instanceId: string;
  file: Instance["missingFiles"][number];
  /** Live from CurseForge; absent if that lookup failed. */
  detail: MissingFileDetail | undefined;
  canManage: boolean;
  onUploaded: () => void;
}) {
  const upload = useMutation({
    mutationFn: (f: File) => instancesApi.uploadCurseForgeFile(instanceId, file.fileId, f),
    onSuccess: onUploaded,
  });

  return (
    <li>
      <div className="checklist-main">
        <strong>{detail?.modName ?? file.fileName}</strong>
        <code>{file.fileName}</code>
        {upload.isError && <div className="error-text">{errorMessage(upload.error, "Upload failed.")}</div>}
      </div>
      {detail && (
        <a className="button-link secondary small" href={detail.pageUrl} target="_blank" rel="noreferrer">
          Download <ExternalIcon />
        </a>
      )}
      {file.uploaded ? (
        <span className="done-mark">✓ Uploaded</span>
      ) : (
        canManage && (
          <label className="button-link small file-pick">
            {upload.isPending ? "Uploading…" : "Upload file"}
            <input
              type="file"
              accept=".jar,.zip"
              disabled={upload.isPending}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = "";
              }}
            />
          </label>
        )
      )}
    </li>
  );
}
