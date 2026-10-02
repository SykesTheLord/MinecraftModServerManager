import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instancesApi } from "../api/instances";
import { errorMessage } from "../api/client";
import type { AutoUpdateMode, Instance, PackVersionOption } from "../api/types";
import { timeAgo } from "../lib/format";

const MODES: { value: AutoUpdateMode; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "Never check for updates." },
  { value: "notify", label: "Notify", help: "Check regularly and show when an update is available." },
  {
    value: "auto",
    label: "Automatic",
    help: "Also install release updates for the same Minecraft version, once the server is running with nobody online (and inside your time window, if you set one).",
  },
];

export function PackUpdatesPanel({ instance }: { instance: Instance }) {
  const queryClient = useQueryClient();
  const [pickVersion, setPickVersion] = useState(false);
  const [confirming, setConfirming] = useState<PackVersionOption | { id: number; name: string } | null>(null);

  const onInstance = (updated: Instance) => {
    queryClient.setQueryData(["instance", instance.id], updated);
    queryClient.invalidateQueries({ queryKey: ["instances"] });
  };

  const check = useMutation({ mutationFn: () => instancesApi.checkForUpdate(instance.id), onSuccess: onInstance });
  const setMode = useMutation({
    mutationFn: (mode: AutoUpdateMode) => instancesApi.updateSettings(instance.id, { autoUpdate: mode }),
    onSuccess: onInstance,
  });
  const apply = useMutation({
    mutationFn: (versionId: number) => instancesApi.applyUpdate(instance.id, versionId),
    onSuccess: (updated) => {
      setConfirming(null);
      setPickVersion(false);
      onInstance(updated);
      queryClient.invalidateQueries({ queryKey: ["versions", instance.id] });
    },
  });

  const { data: versions, isLoading: loadingVersions, error: versionsError } = useQuery({
    queryKey: ["versions", instance.id],
    queryFn: () => instancesApi.versions(instance.id),
    enabled: pickVersion,
  });
  const current = versions?.find((v) => v.current);
  const busy = instance.updating || instance.status === "creating" || apply.isPending;
  const result = instance.update_result;

  return (
    <div>
      <dl className="detail-grid">
        <div>
          <dt>Installed version</dt>
          <dd>{instance.pack_version_name ?? instance.ftb_pack_name}</dd>
        </div>
        <div>
          <dt>Latest update</dt>
          <dd>
            {instance.available_version_name ? (
              <span className="chip accent">{instance.available_version_name}</span>
            ) : instance.update_checked_at ? (
              "Up to date"
            ) : (
              "Not checked yet"
            )}
          </dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>
            {instance.update_checked_at ? timeAgo(instance.update_checked_at) : "Never"}{" "}
            <button className="link small" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? "Checking…" : "Check now"}
            </button>
          </dd>
        </div>
      </dl>
      {check.isError && <p className="error-text">{errorMessage(check.error, "Couldn't check for updates.")}</p>}

      {busy && (
        <div className="callout info">
          <span className="spinner" aria-hidden="true" />
          <p>Updating — the server is backed up, then reinstalled with the new version. Watch the status above.</p>
        </div>
      )}
      {result && !busy && (
        <div className={result.startsWith("Update failed") ? "callout danger" : "callout info"}>
          <p>{result}</p>
        </div>
      )}

      {instance.available_version_id && !busy && !confirming && (
        <div className="form-actions">
          <button onClick={() => setConfirming({ id: instance.available_version_id!, name: instance.available_version_name ?? "the update" })}>
            Update to {instance.available_version_name}
          </button>
        </div>
      )}

      {confirming && (
        <div className="callout warning">
          <div>
            <p>
              <strong>Switch to {confirming.name}?</strong> The server stops, its world and configs are backed up (see the Backups
              tab — the newest 5 are kept), and it's reinstalled with that version.
              {"minecraftVersion" in confirming && current && confirming.minecraftVersion !== current.minecraftVersion && (
                <>
                  {" "}
                  <strong>
                    This changes Minecraft from {current.minecraftVersion} to {confirming.minecraftVersion} — worlds often can't be
                    moved back to an older version.
                  </strong>
                </>
              )}
            </p>
            <div className="form-actions">
              <button onClick={() => apply.mutate(confirming.id)} disabled={apply.isPending}>
                {apply.isPending ? "Starting update…" : "Update now"}
              </button>
              <button className="secondary" onClick={() => setConfirming(null)} disabled={apply.isPending}>
                Cancel
              </button>
            </div>
            {apply.isError && <p className="error-text">{errorMessage(apply.error, "The update failed.")}</p>}
          </div>
        </div>
      )}

      <h3>Automatic updates</h3>
      <div className="mode-options">
        {MODES.map((mode) => (
          <label key={mode.value} className={instance.auto_update === mode.value ? "mode-option selected" : "mode-option"}>
            <input
              type="radio"
              name={`auto-update-${instance.id}`}
              checked={instance.auto_update === mode.value}
              onChange={() => setMode.mutate(mode.value)}
              disabled={setMode.isPending}
            />
            <span>
              <strong>{mode.label}</strong>
              <span className="muted">{mode.help}</span>
            </span>
          </label>
        ))}
      </div>
      {setMode.isError && <p className="error-text">{errorMessage(setMode.error, "Couldn't change the setting.")}</p>}
      {instance.auto_update === "auto" && <UpdateWindowEditor instance={instance} onInstance={onInstance} />}
      {instance.auto_update === "auto" && instance.available_version_id && !busy && (
        <p className="muted">
          {instance.available_version_name} will install automatically once the server is running with nobody online
          {instance.update_window_start
            ? instance.updateWindowOpen
              ? " (the update window is open now)."
              : ` during the update window (${instance.update_window_start}–${instance.update_window_end}).`
            : "."}
        </p>
      )}

      <h3>Other versions</h3>
      {!pickVersion ? (
        <button className="secondary" onClick={() => setPickVersion(true)} disabled={busy}>
          Choose a version…
        </button>
      ) : (
        <>
          {loadingVersions && <p className="muted">Loading versions…</p>}
          {versionsError && <p className="error-text">{errorMessage(versionsError, "Couldn't load versions.")}</p>}
          {versions && (
            <ul className="version-list">
              {versions.map((v) => (
                <li key={v.id}>
                  <button type="button" className="version-row" onClick={() => setConfirming(v)} disabled={v.current || busy}>
                    <span>
                      <span className="name">{v.name}</span>
                      <span className="sub">{v.date ? timeAgo(new Date(v.date)) : "—"}</span>
                    </span>
                    <span className="hide-sm">{v.minecraftVersion ? `Minecraft ${v.minecraftVersion}` : "—"}</span>
                    <span className="hide-sm">{!v.release && <span className="chip warning">pre-release</span>}</span>
                    <span>{v.current ? <span className="chip accent">Installed</span> : <span className="muted">Switch</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Restricts automatic installs to a daily time window, in a time zone of the admin's choosing. */
function windowDraftFrom(instance: Instance) {
  return {
    enabled: Boolean(instance.update_window_start),
    start: instance.update_window_start ?? "03:00",
    end: instance.update_window_end ?? "06:00",
    // A new window starts out in the admin's own time zone.
    timeZone: instance.update_window_tz ?? browserTimeZone(),
  };
}

function UpdateWindowEditor({ instance, onInstance }: { instance: Instance; onInstance: (i: Instance) => void }) {
  const saved = windowDraftFrom(instance);
  const [draft, setDraft] = useState(saved);
  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    return all.includes(draft.timeZone) ? all : [draft.timeZone, ...all];
  }, [draft.timeZone]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: () =>
      instancesApi.updateSettings(instance.id, {
        window: draft.enabled ? { start: draft.start, end: draft.end, timeZone: draft.timeZone } : null,
      }),
    onSuccess: (updated) => {
      onInstance(updated);
      setDraft(windowDraftFrom(updated));
    },
  });

  return (
    <div className="window-editor">
      <label className="checkbox">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        <span>
          Only install automatic updates during a time window
          <span className="muted"> — e.g. overnight, when nobody plays. Checking for updates still happens any time.</span>
        </span>
      </label>
      {draft.enabled && (
        <div className="window-fields">
          <label>
            From
            <input className="input" type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} required />
          </label>
          <label>
            Until
            <input className="input" type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} required />
          </label>
          <label className="grow">
            Time zone
            <select className="input" value={draft.timeZone} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {draft.enabled && draft.start > draft.end && <p className="muted">This window crosses midnight.</p>}
      {saved.enabled && !dirty && (
        <p className="muted">
          {instance.updateWindowOpen ? "The window is open right now." : "Outside the window right now."} ({saved.start}–{saved.end},{" "}
          {saved.timeZone})
        </p>
      )}
      {save.isError && <p className="error-text">{errorMessage(save.error, "Couldn't save the window.")}</p>}
      {dirty && (
        <div className="form-actions">
          <button onClick={() => save.mutate()} disabled={save.isPending || (draft.enabled && draft.start === draft.end)}>
            {save.isPending ? "Saving…" : "Save window"}
          </button>
          <button className="ghost" onClick={() => setDraft(saved)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
