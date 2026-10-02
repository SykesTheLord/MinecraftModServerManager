import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../api/users";
import { instancesApi } from "../api/instances";
import { Layout } from "../components/Layout";
import { errorMessage, latestMutationError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { useCurrentUser } from "../hooks/useCurrentUser";
import type { GlobalRole, Instance, InstanceRole, ManagedUser } from "../api/types";

const PLATFORM_ADMIN_HELP =
  "Full control of the manager: every server, creating and importing servers, and managing users (including other platform admins).";

export function UsersPage() {
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [platformAdmin, setPlatformAdmin] = useState(false);

  const { data: users } = useQuery({ queryKey: ["users"], queryFn: usersApi.list });
  const { data: instances } = useQuery({ queryKey: ["instances"], queryFn: instancesApi.list });

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const createUser = useMutation({
    mutationFn: () => usersApi.create(username, password, platformAdmin ? "superadmin" : "user"),
    onSuccess: () => {
      setUsername("");
      setPassword("");
      setPlatformAdmin(false);
      invalidateUsers();
    },
  });

  const removeUser = useMutation({ mutationFn: (id: string) => usersApi.remove(id), onSuccess: invalidateUsers });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: GlobalRole }) => usersApi.setRole(id, role),
    onSuccess: invalidateUsers,
  });

  // Platform admins first, then everyone else; alphabetical within each.
  const sorted = [...(users ?? [])].sort(
    (a, b) => Number(b.globalRole === "superadmin") - Number(a.globalRole === "superadmin") || a.username.localeCompare(b.username)
  );
  const hasRegularUsers = sorted.some((u) => u.globalRole !== "superadmin");

  return (
    <Layout title="Users">
      <PageHeader
        title="Users"
        subtitle="Platform admins can do everything. Everyone else only sees the servers granted to them below."
      />

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
          <label className="checkbox">
            <input type="checkbox" checked={platformAdmin} onChange={(e) => setPlatformAdmin(e.target.checked)} />
            <span>
              Platform admin
              <span className="hint">{PLATFORM_ADMIN_HELP}</span>
            </span>
          </label>
          {createUser.isError && <p className="error-text">{errorMessage(createUser.error, "Failed to create user.")}</p>}
          <button type="submit" disabled={createUser.isPending}>
            {createUser.isPending ? "Adding…" : platformAdmin ? "Add platform admin" : "Add user"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Existing users</h2>
        {latestMutationError(removeUser, setRole) != null && (
          <p className="error-text">{errorMessage(latestMutationError(removeUser, setRole), "Failed to update the user.")}</p>
        )}
        {hasRegularUsers && instances?.length === 0 && (
          <p className="muted">There are no servers yet, so there's nothing to grant access to.</p>
        )}
        <ul className="user-list">
          {sorted.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isSelf={user.id === me?.id}
              instances={instances ?? []}
              busy={
                (removeUser.isPending && removeUser.variables === user.id) ||
                (setRole.isPending && setRole.variables?.id === user.id)
              }
              onRemove={() => removeUser.mutate(user.id)}
              onSetRole={(role) => setRole.mutate({ id: user.id, role })}
            />
          ))}
        </ul>
        {users && !hasRegularUsers && <p className="muted">No other users yet. Add one above.</p>}
      </section>
    </Layout>
  );
}

function UserRow({
  user,
  isSelf,
  instances,
  busy,
  onRemove,
  onSetRole,
}: {
  user: ManagedUser;
  isSelf: boolean;
  instances: Instance[];
  busy: boolean;
  onRemove: () => void;
  onSetRole: (role: GlobalRole) => void;
}) {
  const [confirming, setConfirming] = useState<"remove" | "role" | null>(null);
  const isPlatformAdmin = user.globalRole === "superadmin";

  return (
    <li className="user-row">
      <div className="user-row-header">
        <span className="avatar" aria-hidden="true">
          {user.username.slice(0, 1)}
        </span>
        <span className="user-name">
          <strong>{user.username}</strong>
          {isSelf && <span className="muted">(you)</span>}
          {isPlatformAdmin && <span className="chip accent">Platform admin</span>}
        </span>
        {!isSelf &&
          (confirming === "remove" ? (
            <>
              <span className="muted">Remove {user.username} and their access?</span>
              <button className="danger small" onClick={onRemove} disabled={busy}>
                {busy ? "Removing…" : "Remove"}
              </button>
              <button className="secondary small" onClick={() => setConfirming(null)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : confirming === "role" ? (
            <>
              <span className="muted">
                {isPlatformAdmin
                  ? `Make ${user.username} a regular user? They keep only the server access granted below.`
                  : `Make ${user.username} a platform admin? ${PLATFORM_ADMIN_HELP}`}
              </span>
              <button
                className={isPlatformAdmin ? "small" : "danger small"}
                onClick={() => {
                  onSetRole(isPlatformAdmin ? "user" : "superadmin");
                  setConfirming(null);
                }}
                disabled={busy}
              >
                {isPlatformAdmin ? "Make regular user" : "Make platform admin"}
              </button>
              <button className="secondary small" onClick={() => setConfirming(null)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="secondary small" onClick={() => setConfirming("role")} disabled={busy}>
                {isPlatformAdmin ? "Remove platform admin…" : "Make platform admin…"}
              </button>
              <button className="secondary small" onClick={() => setConfirming("remove")} disabled={busy}>
                Remove user…
              </button>
            </>
          ))}
      </div>

      {isPlatformAdmin ? (
        <p className="muted user-row-note">Access to every server.</p>
      ) : (
        <AccessGrants userId={user.id} username={user.username} instances={instances} />
      )}
    </li>
  );
}

function AccessGrants({ userId, username, instances }: { userId: string; username: string; instances: Instance[] }) {
  const queryClient = useQueryClient();
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
    <>
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
    </>
  );
}
