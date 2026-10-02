import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { settingsApi } from "../api/settings";
import { usersApi } from "../api/users";
import { Layout } from "../components/Layout";
import { errorMessage } from "../api/client";
import { PageHeader } from "../components/PageHeader";

export function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const mismatch = Boolean(password && confirm && password !== confirm);

  const changePassword = useMutation({
    mutationFn: () => usersApi.changeOwnPassword(currentPassword, password),
    onSuccess: () => {
      setCurrentPassword("");
      setPassword("");
      setConfirm("");
    },
  });

  return (
    <Layout narrow title="Settings">
      <PageHeader title="Settings" subtitle="Your account." />
      <section className="card">
        <h2>Change password</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (mismatch) return;
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
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <span className="hint">At least 8 characters.</span>
          </label>
          <label>
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              aria-invalid={mismatch}
            />
          </label>
          {mismatch && <p className="error-text">Passwords do not match.</p>}
          {changePassword.isError && (
            <p className="error-text">{errorMessage(changePassword.error, "Failed to change password.")}</p>
          )}
          {changePassword.isSuccess && <p className="success-text">Password updated. Other sessions have been logged out.</p>}
          <button type="submit" disabled={changePassword.isPending || mismatch}>
            {changePassword.isPending ? "Updating…" : "Update password"}
          </button>
        </form>
      </section>
      <AboutCard />
    </Layout>
  );
}

function AboutCard() {
  const { data } = useQuery({ queryKey: ["app-version"], queryFn: settingsApi.version });
  return (
    <section className="card">
      <h2>About</h2>
      <dl className="detail-grid">
        <div>
          <dt>Version</dt>
          <dd>{data?.version ?? "…"}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd>
            <code>{data?.commit ?? "…"}</code>
          </dd>
        </div>
      </dl>
      <p className="muted">
        To update, run <code>./scripts/update.sh</code> on the host (<code>--check</code> to see what's new first).
      </p>
    </section>
  );
}
