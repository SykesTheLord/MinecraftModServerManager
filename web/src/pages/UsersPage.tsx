import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../api/users";
import { instancesApi } from "../api/instances";
import { Layout } from "../components/Layout";
import { ApiError, errorMessage, latestMutationError } from "../api/client";
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

  return (
    <Layout>
      <h1>Users</h1>

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
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>
          {createUser.isError && (
            <p className="error-text">
              {createUser.error instanceof ApiError ? createUser.error.message : "Failed to create user."}
            </p>
          )}
          <button type="submit" disabled={createUser.isPending}>
            Add user
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Existing users</h2>
        {removeUser.isError && <p className="error-text">{errorMessage(removeUser.error, "Failed to remove user.")}</p>}
        <ul className="user-list">
          {users
            ?.filter((u) => u.globalRole !== "superadmin")
            .map((user) => (
              <UserRow
                key={user.id}
                userId={user.id}
                username={user.username}
                instances={instances ?? []}
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
  onRemove,
}: {
  userId: string;
  username: string;
  instances: Instance[];
  onRemove: () => void;
}) {
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
    <li className="user-row">
      <strong>{username}</strong>
      <button onClick={onRemove}>Remove user</button>

      {latestMutationError(grant, revoke) != null && (
        <p className="error-text">{errorMessage(latestMutationError(grant, revoke), "Failed to update access.")}</p>
      )}
      <div className="instance-access-grants">
        {instances.map((instance) => (
          <div key={instance.id} className="instance-access-row">
            <span>{instance.name}</span>
            <select
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
