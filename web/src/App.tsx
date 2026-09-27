import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { NewInstanceWizard } from "./pages/NewInstanceWizard";
import { InstanceDetailPage } from "./pages/InstanceDetailPage";
import { UsersPage } from "./pages/UsersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { RequireAuth, RequireSuperadmin } from "./components/RequireAuth";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/instances/new"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <NewInstanceWizard />
              </RequireSuperadmin>
            </RequireAuth>
          }
        />
        <Route
          path="/instances/:id"
          element={
            <RequireAuth>
              <InstanceDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/users"
          element={
            <RequireAuth>
              <RequireSuperadmin>
                <UsersPage />
              </RequireSuperadmin>
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
