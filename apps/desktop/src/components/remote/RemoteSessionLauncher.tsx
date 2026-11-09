import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { catalogAgents, directRemoteHosts } from "../../lib/remote-direct-session";
import { remoteHostErrorKey } from "../../lib/remote-host-errors";
import { useAppStore } from "../../stores/app-store";
import { IconFolder, IconGlobe } from "../icons";
import { Button, TooltipButton } from "../ui";
import { RemoteFolderDialog } from "./RemoteFolderDialog";

export type DirectRemoteSessionRequest = {
  hostKey: string;
  /** Remote absolute cwd; absent means the host's home directory. */
  cwd?: string;
  remoteProvider?: string;
};

/**
 * Inline sidebar panel behind the "new remote session" toolbar button: pick a
 * Perch/Kimi host and the session starts in that host's home directory — or
 * browse for another folder first. No project is registered either way; the
 * project layer stays optional organization on top of the same sessions.
 */
export function RemoteSessionLauncher({ onCreate, onClose }: {
  onCreate: (request: DirectRemoteSessionRequest) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<RemoteHostSummary[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  // The agent picker remembers a browsed cwd so the choice still applies.
  const [agentPicker, setAgentPicker] = useState<{ hostKey: string; cwd?: string } | null>(null);
  const [browseHost, setBrowseHost] = useState<RemoteHostSummary | null>(null);
  const remoteModelCatalogs = useAppStore((state) => state.remoteModelCatalogs);
  const loadRemoteModelCatalog = useAppStore((state) => state.loadRemoteModelCatalog);

  useEffect(() => {
    let active = true;
    setError("");
    void (async () => {
      try {
        const result = await api.listRemoteHosts();
        if (active) setHosts(directRemoteHosts(result.hosts));
      } catch (caught) {
        if (active) {
          setHosts([]);
          setError(t(remoteHostErrorKey(caught)));
        }
      }
    })();
    return () => { active = false; };
  }, [reload, t]);

  const create = async (host: RemoteHostSummary, agent?: string, cwd?: string) => {
    if (busy) return;
    setBusy(host.hostKey);
    setAgentPicker(null);
    try {
      await onCreate({
        hostKey: host.hostKey,
        ...(agent ? { remoteProvider: agent } : {}),
        ...(cwd ? { cwd } : {}),
      });
      onClose();
    } catch {
      // The caller reports the failure; the panel stays open for a retry.
    } finally {
      setBusy(null);
    }
  };

  // Same agent-choice rule as the remote project groups: several runtimes ask
  // first, exactly one is used silently, none falls back to the host default.
  // A catalog that fails to load surfaces its recorded error, never a silent
  // default on a multi-runtime host.
  const requestCreate = async (host: RemoteHostSummary, cwd?: string) => {
    if (busy) return;
    let catalog = remoteModelCatalogs[host.hostKey];
    if (catalog === undefined) {
      try {
        await loadRemoteModelCatalog(host.hostKey);
        catalog = useAppStore.getState().remoteModelCatalogs[host.hostKey];
      } catch (caught) {
        useAppStore.getState().showToast(
          caught instanceof Error ? caught.message : String(caught),
          { variant: "error" },
        );
        return;
      }
      if (catalog === undefined) {
        const loadError = useAppStore.getState().remoteModelCatalogErrors[host.hostKey];
        if (loadError) {
          useAppStore.getState().showToast(loadError, { variant: "error" });
          return;
        }
      }
    }
    const agents = catalogAgents(catalog);
    if (catalog !== undefined && agents.length > 1) {
      setAgentPicker((current) =>
        current?.hostKey === host.hostKey && current.cwd === cwd
          ? null
          : { hostKey: host.hostKey, ...(cwd ? { cwd } : {}) },
      );
    } else if (catalog !== undefined && agents.length === 1) {
      void create(host, agents[0], cwd);
    } else {
      void create(host, undefined, cwd);
    }
  };

  return (
    <div
      className="sidebar-remote-launch"
      role="group"
      aria-label={t("remote:newRemoteSession")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <p className="sidebar-remote-launch-hint">{t("remote:directCreateHint")}</p>
      {hosts === null && !error ? (
        <p className="sidebar-remote-launch-status" role="status">{t("remote:loading")}</p>
      ) : null}
      {error ? (
        <div className="sidebar-remote-launch-error">
          <p className="remote-project-error" role="alert">{error}</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setHosts(null);
              setReload((value) => value + 1);
            }}
          >
            {t("remote:retry")}
          </Button>
        </div>
      ) : null}
      {hosts !== null && !error && hosts.length === 0 ? (
        <p className="sidebar-remote-launch-status">{t("remote:noDirectHosts")}</p>
      ) : null}
      {(hosts ?? []).map((host) => (
        <div key={host.hostKey} className="sidebar-remote-launch-host">
          <div className="sidebar-remote-launch-row">
            <TooltipButton
              type="button"
              className="sidebar-remote-launch-create"
              tooltip={host.connected
                ? t("remote:newRemoteSessionOn", { label: host.label })
                : t("remote:offlineHost", { label: host.label })}
              ariaLabel={t("remote:newRemoteSessionOn", { label: host.label })}
              aria-expanded={agentPicker?.hostKey === host.hostKey}
              disabled={busy !== null}
              onClick={() => void requestCreate(host)}
            >
              <IconGlobe size={13} aria-hidden />
              <span className="sidebar-remote-launch-label">{host.label}</span>
            </TooltipButton>
            <TooltipButton
              type="button"
              className="sidebar-remote-launch-browse"
              tooltip={t("remote:browseFolders")}
              ariaLabel={t("remote:browseFolders")}
              disabled={busy !== null}
              onClick={() => setBrowseHost(host)}
            >
              <IconFolder size={13} />
            </TooltipButton>
          </div>
          {agentPicker?.hostKey === host.hostKey ? (
            <div
              className="sidebar-remote-agent-picker"
              role="group"
              aria-label={t("remote:chooseAgent")}
            >
              {catalogAgents(remoteModelCatalogs[host.hostKey]).map((agent) => (
                <button
                  key={agent}
                  type="button"
                  className="sidebar-remote-agent-option"
                  disabled={busy !== null}
                  onClick={() => void create(host, agent, agentPicker.cwd)}
                >
                  {agent}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      {browseHost ? (
        <RemoteFolderDialog
          key={browseHost.hostKey}
          hostKey={browseHost.hostKey}
          hostLabel={browseHost.label}
          initialPath=""
          onChoose={(path) => {
            const host = browseHost;
            setBrowseHost(null);
            void requestCreate(host, path);
          }}
          onClose={() => setBrowseHost(null)}
        />
      ) : null}
    </div>
  );
}
