import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { usersApi } from "../api/users";
import { Layout } from "../components/Layout";
import { ApiError } from "../api/client";

export function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const changePassword = useMutation({
    mutationFn: () => usersApi.changeOwnPassword(currentPassword, password),
    onSuccess: () => {
      setCurrentPassword("");
      setPassword("");
      setConfirm("");
    },
  });

  return (
    <Layout>
      <h1>Settings</h1>
      <section className="card">
        <h2>Change password</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== confirm) return;
            changePassword.mutate();
          }}
        >
          <label>
            Current password
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            New password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
          </label>
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
          </label>
          {password && confirm && password !== confirm && <p className="error-text">Passwords do not match.</p>}
          {changePassword.isError && (
            <p className="error-text">
              {changePassword.error instanceof ApiError ? changePassword.error.message : "Failed to change password."}
            </p>
          )}
          {changePassword.isSuccess && <p className="success-text">Password updated. Other sessions have been logged out.</p>}
          <button type="submit" disabled={changePassword.isPending}>
            Update password
          </button>
        </form>
      </section>
    </Layout>
  );
}
