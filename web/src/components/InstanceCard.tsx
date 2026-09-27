import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Instance } from "../api/types";
import { instancesApi } from "../api/instances";
import { StatusBadge } from "./StatusBadge";
import { errorMessage, latestMutationError } from "../api/client";

export function InstanceCard({ instance }: { instance: Instance }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["instances"] });

  const start = useMutation({ mutationFn: () => instancesApi.start(instance.id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => instancesApi.stop(instance.id), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => instancesApi.restart(instance.id), onSuccess: invalidate });

  const canOperate = instance.effectiveRole === "admin" || instance.effectiveRole === "operator";
  const isRunning = instance.status === "running" || instance.status === "installing";
  const actionError = latestMutationError(start, stop, restart);

  return (
    <div className="card instance-card">
      <div className="instance-card-header">
        <h3>
          <Link to={`/instances/${instance.id}`}>{instance.name}</Link>
        </h3>
        <StatusBadge status={instance.status} />
      </div>
      <p className="instance-subdomain">{instance.subdomain}</p>
      <p className="instance-pack">{instance.ftb_pack_name}</p>
      {instance.status === "error" && instance.last_error && (
        <p className="instance-error">{instance.last_error.slice(-200)}</p>
      )}
      {canOperate && (
        <div className="instance-card-actions">
          {isRunning ? (
            <>
              <button onClick={() => stop.mutate()} disabled={stop.isPending}>
                Stop
              </button>
              <button onClick={() => restart.mutate()} disabled={restart.isPending}>
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
      {actionError != null && <p className="error-text">{errorMessage(actionError, "Action failed.")}</p>}
    </div>
  );
}
