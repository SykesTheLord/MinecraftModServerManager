import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instancesApi } from "../api/instances";
import { ApiError, errorMessage } from "../api/client";
import type { ServerProperty } from "../api/types";
import { SearchIcon } from "./Icons";

/** Friendlier editing for the properties people actually change; anything else is a plain text field. */
const KNOWN: Record<string, { help: string; options?: string[] }> = {
  motd: { help: "Message shown under the server name in the multiplayer list." },
  "max-players": { help: "Maximum players online at once." },
  difficulty: { help: "World difficulty.", options: ["peaceful", "easy", "normal", "hard"] },
  gamemode: { help: "Game mode for new players.", options: ["survival", "creative", "adventure", "spectator"] },
  "force-gamemode": { help: "Put players in the default game mode every time they join.", options: ["true", "false"] },
  hardcore: { help: "Players are banned on death.", options: ["true", "false"] },
  pvp: { help: "Players can damage each other.", options: ["true", "false"] },
  "white-list": { help: "Only whitelisted players can join (manage with /whitelist in the console).", options: ["true", "false"] },
  "enforce-whitelist": { help: "Kick players not on the whitelist when it's reloaded.", options: ["true", "false"] },
  "online-mode": { help: "Check players against Mojang's account servers. Leave on unless you know why not.", options: ["true", "false"] },
  "allow-flight": { help: "Don't kick players for flying (many modpacks need this on).", options: ["true", "false"] },
  "allow-nether": { help: "The Nether is enabled.", options: ["true", "false"] },
  "spawn-monsters": { help: "Hostile mobs spawn.", options: ["true", "false"] },
  "spawn-animals": { help: "Animals spawn.", options: ["true", "false"] },
  "spawn-npcs": { help: "Villagers spawn.", options: ["true", "false"] },
  "enable-command-block": { help: "Command blocks work.", options: ["true", "false"] },
  "generate-structures": { help: "Villages, temples etc. generate in new chunks.", options: ["true", "false"] },
  "view-distance": { help: "Chunks sent to players (lower = less load)." },
  "simulation-distance": { help: "Chunks around players that are ticked." },
  "spawn-protection": { help: "Radius around spawn only operators can build in (0 = off)." },
  "player-idle-timeout": { help: "Minutes before idle players are kicked (0 = never)." },
  "op-permission-level": { help: "What operators may do (1–4).", options: ["1", "2", "3", "4"] },
  "level-seed": { help: "Seed for new worlds (no effect on an existing world)." },
  "level-type": { help: "World type for new worlds." },
  "max-world-size": { help: "World border radius in blocks." },
  "max-tick-time": { help: "Milliseconds a tick may take before the watchdog stops the server (-1 = off)." },
  "level-name": { help: "World folder. Changing it switches to (or creates) a different world." },
};

interface Row {
  key: string;
  value: string;
  managed: string | null;
}

export function ServerPropertiesEditor({ instanceId, running }: { instanceId: string; running: boolean }) {
  const queryClient = useQueryClient();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["properties", instanceId],
    queryFn: () => instancesApi.properties(instanceId),
    retry: false,
  });

  // Draft edits, keyed by property; `null` means removed. Reset whenever a fresh copy is loaded.
  const [draft, setDraft] = useState<{ revision: string; edits: Record<string, string | null>; added: string[] }>({
    revision: "",
    edits: {},
    added: [],
  });
  const edits = draft.revision === data?.revision ? draft.edits : {};
  const added = draft.revision === data?.revision ? draft.added : [];
  const [filter, setFilter] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const rows: Row[] = [
    ...(data?.properties ?? []).map((p: ServerProperty) => ({ ...p })),
    ...added.map((key) => ({ key, value: "", managed: null })),
  ]
    .filter((r) => edits[r.key] !== null)
    .map((r) => ({ ...r, value: edits[r.key] ?? r.value }))
    .sort((a, b) => Number(Boolean(a.managed)) - Number(Boolean(b.managed)) || a.key.localeCompare(b.key));

  const dirty = Object.keys(edits).length > 0 || added.length > 0;
  const visible = rows.filter((r) => !filter || r.key.includes(filter.toLowerCase()) || r.value.toLowerCase().includes(filter.toLowerCase()));

  const update = (key: string, value: string | null) =>
    setDraft({ revision: data!.revision, edits: { ...edits, [key]: value }, added });

  const save = useMutation({
    mutationFn: (restart: boolean) => {
      const properties: Record<string, string> = {};
      for (const row of rows) if (!row.managed) properties[row.key] = row.value;
      return instancesApi.saveProperties(instanceId, properties, data!.revision, restart);
    },
    onSuccess: (view) => {
      queryClient.setQueryData(["properties", instanceId], { properties: view.properties, revision: view.revision });
      queryClient.invalidateQueries({ queryKey: ["instance", instanceId] });
      setDraft({ revision: view.revision, edits: {}, added: [] });
    },
  });

  if (isLoading) return <p className="muted">Loading server.properties…</p>;
  if (error || !data) {
    return <div className="empty-state">{errorMessage(error, "Couldn't read server.properties.")}</div>;
  }

  const conflict = save.error instanceof ApiError && save.error.status === 409;

  return (
    <div>
      <div className="toolbar">
        <label className="search">
          <SearchIcon />
          <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter properties" aria-label="Filter properties" />
        </label>
        <span className="count">{rows.length} properties</span>
      </div>

      <ul className="property-list">
        {visible.map((row) => {
          const known = KNOWN[row.key];
          const changed = row.key in edits || added.includes(row.key);
          return (
            <li key={row.key} className={changed ? "changed" : undefined}>
              <div className="property-key">
                <code>{row.key}</code>
                {(row.managed ?? known?.help) && <span className="muted">{row.managed ?? known?.help}</span>}
              </div>
              <div className="property-value">
                {row.managed ? (
                  <input className="input" value={row.value} disabled />
                ) : known?.options && known.options.includes(row.value) ? (
                  <select className="input" value={row.value} onChange={(e) => update(row.key, e.target.value)} aria-label={row.key}>
                    {known.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input" value={row.value} onChange={(e) => update(row.key, e.target.value)} aria-label={row.key} />
                )}
                {!row.managed && (
                  <button type="button" className="ghost small" title={`Remove ${row.key}`} onClick={() => update(row.key, null)}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <form
        className="add-property"
        onSubmit={(e) => {
          e.preventDefault();
          const key = newKey.trim();
          if (!key || rows.some((r) => r.key === key)) return;
          setDraft({ revision: data.revision, edits: { ...edits, [key]: newValue }, added: [...added, key] });
          setNewKey("");
          setNewValue("");
        }}
      >
        <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="new-property" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" aria-label="New property name" />
        <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="value" aria-label="New property value" />
        <button type="submit" className="secondary">
          Add
        </button>
      </form>

      <div className="callout info">
        <p>Minecraft reads this file when it starts, so changes take effect after a restart.</p>
      </div>
      {save.isError && (
        <p className="error-text">
          {errorMessage(save.error, "Couldn't save server.properties.")}{" "}
          {conflict && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setDraft({ revision: "", edits: {}, added: [] });
                save.reset();
                void refetch();
              }}
            >
              Reload (discards your changes)
            </button>
          )}
        </p>
      )}
      {save.isSuccess && !dirty && (
        <p className="success-text">{save.data.restarted ? "Saved. The server is restarting." : "Saved. Restart the server to apply."}</p>
      )}
      <div className="form-actions">
        {running && (
          <button onClick={() => save.mutate(true)} disabled={!dirty || save.isPending}>
            Save & restart
          </button>
        )}
        <button className={running ? "secondary" : undefined} onClick={() => save.mutate(false)} disabled={!dirty || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button className="ghost" onClick={() => setDraft({ revision: "", edits: {}, added: [] })}>
            Discard changes
          </button>
        )}
      </div>
    </div>
  );
}
