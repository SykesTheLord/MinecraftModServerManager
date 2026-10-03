import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instancesApi } from "../api/instances";
import { errorMessage } from "../api/client";
import type { BackupInfo, Instance } from "../api/types";
import { formatBytes, timeAgo } from "../lib/format";

const REASONS: Record<NonNullable<BackupInfo["reason"]>, string> = {
  update: "Before an update",
  manual: "Manual",
  restore: "Before a restore",
};

function currentVersionId(instance: Instance): number | null {
  if (instance.source === "ftb") return instance.ftb_version_id;
  if (instance.source === "curseforge") return instance.cf_file_id;
  return null;
}

/**
 * World/config backups kept in the server's own volume — made before every
 * update and restore, or on demand — and restoring them.
 */
export function BackupsPanel({ instance }: { instance: Instance }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<BackupInfo | null>(null);
  const [switchVersion, setSwitchVersion] = useState(true);

  const { data: backups, isLoading, error } = useQuery({
    queryKey: ["backups", instance.id],
    queryFn: () => instancesApi.backups(instance.id),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["backups", instance.id] });
    queryClient.invalidateQueries({ queryKey: ["instance", instance.id] });
    queryClient.invalidateQueries({ queryKey: ["instances"] });
  };

  const backupNow = useMutation({ mutationFn: () => instancesApi.createBackup(instance.id), onSuccess: refresh });
  const restore = useMutation({
    mutationFn: (backup: BackupInfo) => instancesApi.restoreBackup(instance.id, backup.name, switchVersion),
    onSuccess: () => {
      setConfirming(null);
      refresh();
    },
  });

  const busy =
    instance.updating || instance.status === "creating" || instance.status === "stopping" || restore.isPending || backupNow.isPending;
  const running = instance.status === "running";
  const versionDiffers = (b: BackupInfo) =>
    Boolean(b.versionId) && b.versionId !== currentVersionId(instance) && instance.source !== "import";
  const result = instance.update_result;

  return (
    <div>
      <p className="muted">
        Each backup holds the world, configs, <code>server.properties</code> and player data (mods and libraries are
        re-downloaded, so they're left out). One is made automatically before every update and restore; the newest 5 are
        kept, inside the server's own volume.
      </p>

      <div className="form-actions">
        <button onClick={() => backupNow.mutate()} disabled={busy || instance.status === "installing"}>
          {backupNow.isPending ? "Backing up…" : "Back up now"}
        </button>
        {running && <span className="muted">The server keeps running: saving is paused for the moment it takes.</span>}
      </div>
      {backupNow.isError && <p className="error-text">{errorMessage(backupNow.error, "The backup failed.")}</p>}
      {backupNow.isSuccess && <p className="success-text">Backed up as {backupNow.data.name}.</p>}

      {busy && !backupNow.isPending && (
        <div className="callout info">
          <span className="spinner" aria-hidden="true" />
          <p>
            {instance.status === "stopping"
              ? "The server is stopping (saving its world first). This is available again once it has stopped."
              : "Working on this server (update, restore or backup) — the list refreshes when it's done."}
          </p>
        </div>
      )}
      {result && !busy && /^(Restor|Update failed)/.test(result) && (
        <div className={/failed/.test(result) ? "callout danger" : "callout info"}>
          <p>{result}</p>
        </div>
      )}

      {isLoading && <p className="muted">Loading backups…</p>}
      {error && <p className="error-text">{errorMessage(error, "Couldn't list backups.")}</p>}
      {backups?.length === 0 && <div className="empty-state">No backups yet.</div>}

      {backups && backups.length > 0 && (
        <ul className="checklist backup-list">
          {backups.map((b) => (
            <li key={b.name}>
              <div className="checklist-main">
                <strong>
                  {new Date(b.createdAt).toLocaleString()} <span className="muted">· {timeAgo(b.createdAt)}</span>
                </strong>
                <span className="chip-row">
                  <span className="chip">{b.reason ? REASONS[b.reason] : "Backup"}</span>
                  {b.versionName && <span className="chip">{b.versionName}</span>}
                  <span className="chip">{formatBytes(b.sizeBytes)}</span>
                </span>
              </div>
              <button
                className="secondary small"
                onClick={() => {
                  setSwitchVersion(true);
                  setConfirming(b);
                }}
                disabled={busy}
              >
                Restore…
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirming && (
        <div className="callout warning">
          <div>
            <p>
              <strong>Restore the backup from {new Date(confirming.createdAt).toLocaleString()}?</strong>{" "}
              {running || instance.status === "installing" ? "The server stops, " : ""}
              its current world and configs are saved as a new backup first (so this can be undone), then replaced with
              this backup's.{running ? " It starts again afterwards." : ""}
            </p>
            {versionDiffers(confirming) && (
              <label className="checkbox">
                <input type="checkbox" checked={switchVersion} onChange={(e) => setSwitchVersion(e.target.checked)} />
                <span>
                  Also switch the pack back to <strong>{confirming.versionName}</strong>, the version this backup was taken
                  on (recommended — the world was saved by that version's mods).
                </span>
              </label>
            )}
            <div className="form-actions">
              <button className="danger" onClick={() => restore.mutate(confirming)} disabled={restore.isPending}>
                {restore.isPending ? "Restoring…" : "Restore"}
              </button>
              <button className="secondary" onClick={() => setConfirming(null)} disabled={restore.isPending}>
                Cancel
              </button>
            </div>
            {restore.isError && <p className="error-text">{errorMessage(restore.error, "The restore failed.")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
