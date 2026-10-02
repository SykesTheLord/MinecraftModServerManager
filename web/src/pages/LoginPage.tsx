import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { errorMessage } from "../api/client";
import { BrandMark } from "../components/Icons";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useDocumentTitle("Sign in");

  const login = useMutation({
    mutationFn: () => authApi.login(username, password),
    onSuccess: (user) => {
      // Nothing cached from an earlier (expired) session should outlive it.
      queryClient.clear();
      queryClient.setQueryData(["me"], user);
      navigate("/");
    },
  });

  return (
    <div className="login-page">
      <form
        className="card login-form"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <div className="brand">
          <BrandMark />
          <h1>Mod Server Manager</h1>
          <span className="muted">Sign in to manage your servers</span>
        </div>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {login.isError && (
          <p className="error-text" role="alert">
            {errorMessage(login.error, "Login failed.")}
          </p>
        )}
        <button type="submit" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
