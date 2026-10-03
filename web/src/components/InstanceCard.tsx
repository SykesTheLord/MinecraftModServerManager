import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Instance } from "../api/types";
import { instancesApi } from "../api/instances";
import { SourceChip, StatusBadge } from "./StatusBadge";
import { CopyButton } from "./CopyButton";
import { errorMessage, latestMutationError } from "../api/client";
import { formatMemory } from "../lib/format";

export function InstanceCard({ instance, baseDomain }: { instance: Instance; baseDomain?: string }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["instances"] });

  const start = useMutation({ mutationFn: () => instancesApi.start(instance.id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => instancesApi.stop(instance.id), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => instancesApi.restart(instance.id), onSuccess: invalidate });

  const canOperate = instance.effectiveRole === "admin" || instance.effectiveRole === "operator";
  const isRunning = instance.status === "running" || instance.status === "installing";
  const isStopping = instance.status === "stopping";
  const hasServer = Boolean(instance.container_id);
  const actionError = latestMutationError(start, stop, restart);
  const address = baseDomain ? `${instance.subdomain}.${baseDomain}` : instance.subdomain;

  return (
    <div className="card instance-card">
      <div className="instance-card-header">
        <h3>
          <Link to={`/instances/${instance.id}`}>{instance.name}</Link>
        </h3>
        <StatusBadge status={instance.status} />
      </div>
      <p className="instance-subdomain" title="Server address">
        {address}
        <CopyButton text={address} />
      </p>
      <p className="instance-pack">{instance.ftb_pack_name}</p>
      <div className="instance-meta">
        <SourceChip source={instance.source} />
        <span className="chip">{formatMemory(instance.memory_mb)}</span>
        {instance.available_version_id && <span className="chip accent">Update available</span>}
        {instance.updating && <span className="chip warning">Updating…</span>}
      </div>
      {instance.status === "error" && instance.last_error && (
        <p className="instance-error">{instance.last_error.slice(-300)}</p>
      )}
      {instance.status === "awaiting_files" && (
        <p className="instance-pack">
          {instance.missingFiles.length} mod file(s) need a manual download — <Link to={`/instances/${instance.id}`}>open</Link>.
        </p>
      )}
      <div className="instance-card-actions">
        {canOperate && hasServer && (
          <>
            {isStopping ? (
              <button className="secondary small" disabled>
                Stopping…
              </button>
            ) : isRunning ? (
              <>
                <button className="secondary small" onClick={() => stop.mutate()} disabled={stop.isPending}>
                  {stop.isPending ? "Stopping…" : "Stop"}
                </button>
                <button className="secondary small" onClick={() => restart.mutate()} disabled={restart.isPending}>
                  Restart
                </button>
              </>
            ) : (
              <button className="small" onClick={() => start.mutate()} disabled={start.isPending}>
                {start.isPending ? "Starting…" : "Start"}
              </button>
            )}
          </>
        )}
        <Link to={`/instances/${instance.id}`} className="button-link secondary small">
          {canOperate && hasServer ? "Console" : canOperate ? "Manage" : "Details"}
        </Link>
      </div>
      {actionError != null && <p className="error-text">{errorMessage(actionError, "Action failed.")}</p>}
    </div>
  );
}
