import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../api/users";
import { instancesApi } from "../api/instances";
import { Layout } from "../components/Layout";
import { errorMessage, latestMutationError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import type { Instance, InstanceRole } from "../api/types";

export function UsersPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const { data: users } = useQuery({ queryKey: ["users"], queryFn: usersApi.list });
  const { data: instances } = useQuery({ queryKey: ["instances"], queryFn: instancesApi.list });

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const createUser = useMutation({
    mutationFn: () => usersApi.create(username, password, "user"),
    onSuccess: () => {
      setUsername("");
      setPassword("");
      invalidateUsers();
    },
  });

  const removeUser = useMutation({ mutationFn: (id: string) => usersApi.remove(id), onSuccess: invalidateUsers });
  const superadmins = users?.filter((u) => u.globalRole === "superadmin") ?? [];
  const regularUsers = users?.filter((u) => u.globalRole !== "superadmin") ?? [];

  return (
    <Layout title="Users">
      <PageHeader title="Users" subtitle="Superadmins can do everything. Everyone else only sees the servers granted to them below." />

      <section className="card">
        <h2>Add user</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createUser.mutate();
          }}
        >
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <span className="hint">At least 8 characters. Share it with them privately; they can change it under Settings.</span>
          </label>
          {createUser.isError && (
            <p className="error-text">{errorMessage(createUser.error, "Failed to create user.")}</p>
          )}
          <button type="submit" disabled={createUser.isPending}>
            {createUser.isPending ? "Adding…" : "Add user"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Existing users</h2>
        {superadmins.length > 0 && (
          <p className="muted">
            Superadmin{superadmins.length === 1 ? "" : "s"} (access to everything):{" "}
            {superadmins.map((u) => u.username).join(", ")}
          </p>
        )}
        {removeUser.isError && <p className="error-text">{errorMessage(removeUser.error, "Failed to remove user.")}</p>}
        {users && regularUsers.length === 0 && <div className="empty-state">No other users yet. Add one above.</div>}
        {regularUsers.length > 0 && instances?.length === 0 && (
          <p className="muted">There are no servers yet, so there's nothing to grant access to.</p>
        )}
        <ul className="user-list">
          {regularUsers.map((user) => (
            <UserRow
              key={user.id}
              userId={user.id}
              username={user.username}
              instances={instances ?? []}
              removing={removeUser.isPending && removeUser.variables === user.id}
              onRemove={() => removeUser.mutate(user.id)}
            />
          ))}
        </ul>
      </section>
    </Layout>
  );
}

function UserRow({
  userId,
  username,
  instances,
  removing,
  onRemove,
}: {
  userId: string;
  username: string;
  instances: Instance[];
  removing: boolean;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { data: access } = useQuery({ queryKey: ["user-access", userId], queryFn: () => usersApi.listAccess(userId) });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["user-access", userId] });
  const grant = useMutation({
    mutationFn: ({ instanceId, role }: { instanceId: string; role: InstanceRole }) =>
      usersApi.grantAccess(userId, instanceId, role),
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: (instanceId: string) => usersApi.revokeAccess(userId, instanceId),
    onSuccess: invalidate,
  });

  const roleFor = (instanceId: string) => access?.find((a) => a.instanceId === instanceId)?.role ?? "";

  return (
    <li className="user-row">
      <div className="user-row-header">
        <span className="avatar" aria-hidden="true">
          {username.slice(0, 1)}
        </span>
        <strong>{username}</strong>
        {confirmingRemove ? (
          <>
            <span className="muted">Remove {username} and their access?</span>
            <button className="danger small" onClick={onRemove} disabled={removing}>
              {removing ? "Removing…" : "Remove"}
            </button>
            <button className="secondary small" onClick={() => setConfirmingRemove(false)} disabled={removing}>
              Cancel
            </button>
          </>
        ) : (
          <button className="secondary small" onClick={() => setConfirmingRemove(true)}>
            Remove user…
          </button>
        )}
      </div>

      {latestMutationError(grant, revoke) != null && (
        <p className="error-text">{errorMessage(latestMutationError(grant, revoke), "Failed to update access.")}</p>
      )}
      <div className="instance-access-grants">
        {instances.map((instance) => (
          <div key={instance.id} className="instance-access-row">
            <span>{instance.name}</span>
            <select
              aria-label={`${username}'s access to ${instance.name}`}
              disabled={grant.isPending || revoke.isPending}
              value={roleFor(instance.id)}
              onChange={(e) => {
                const role = e.target.value;
                if (role === "") revoke.mutate(instance.id);
                else grant.mutate({ instanceId: instance.id, role: role as InstanceRole });
              }}
            >
              <option value="">No access</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        ))}
      </div>
    </li>
  );
}
