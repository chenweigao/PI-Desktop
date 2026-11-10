import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { REMOTE_AGENT_PERMISSION_CATALOG, type RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { catalogAgents, directRemoteHosts } from "../../lib/remote-direct-session";
import { remoteHostErrorKey } from "../../lib/remote-host-errors";
import { useAppStore } from "../../stores/app-store";
import { IconFolder, IconGlobe } from "../icons";
import { Button, TooltipButton } from "../ui";
import { SettingsMenuSelect } from "../settings/SettingsMenuSelect";
import { RemoteFolderDialog } from "./RemoteFolderDialog";

export type DirectRemoteSessionRequest = {
  hostKey: string;
  /** Remote absolute cwd; absent means the host's home directory. */
  cwd?: string;
  remoteProvider?: string;
  /** The runtime's own permission option id, fixed at creation for some runtimes. */
  permissionMode?: string;
};

/** The open configuration for one host's pending session. */
type LaunchConfig = {
  hostKey: string;
  cwd?: string;
  agent?: string;
  permissionMode?: string;
};

/**
 * Inline sidebar panel behind the "new remote session" toolbar button. One
 * click on a host opens a single configuration row set — runtime, permission,
 * folder — with working defaults; one more click on Create starts the session.
 * No successive pickers, no required project object.
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
  const [config, setConfig] = useState<LaunchConfig | null>(null);
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

  const create = async (host: RemoteHostSummary, request: LaunchConfig) => {
    if (busy) return;
    setBusy(host.hostKey);
    setConfig(null);
    try {
      await onCreate({
        hostKey: host.hostKey,
        ...(request.agent ? { remoteProvider: request.agent } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      });
      onClose();
    } catch {
      // The caller reports the failure; the panel stays open for a retry.
    } finally {
      setBusy(null);
    }
  };

  /**
   * One click opens the configuration rows with defaults already chosen:
   * the catalog's single/first runtime and that runtime's default permission
   * mode. A catalog failure surfaces its recorded error, never a silent
   * default on a multi-runtime host.
   */
  const openConfig = async (host: RemoteHostSummary, cwd?: string) => {
    if (busy) return;
    if (config?.hostKey === host.hostKey && config.cwd === cwd) {
      setConfig(null);
      return;
    }
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
    // Multiple runtimes never default silently; a single one is preselected.
    const agent = agents.length === 1 ? agents[0] : undefined;
    const permissionCatalog = agent ? REMOTE_AGENT_PERMISSION_CATALOG[agent] : undefined;
    setConfig({
      hostKey: host.hostKey,
      ...(cwd ? { cwd } : {}),
      ...(agent ? { agent } : {}),
      ...(permissionCatalog ? { permissionMode: permissionCatalog.default } : {}),
    });
  };

  const permissionOptions = (agent: string | undefined) => {
    const catalog = agent ? REMOTE_AGENT_PERMISSION_CATALOG[agent] : undefined;
    return catalog && catalog.options.length > 1 ? catalog : undefined;
  };

  const permissionLabel = (agent: string | undefined, id: string) =>
    agent
      ? t(`chat.remotePermissionOption.${agent}.${id}`, {
          defaultValue: t(`chat.remotePermissionOption.${id}`, { defaultValue: id }),
        })
      : id;

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
      {(hosts ?? []).map((host) => {
        const open = config?.hostKey === host.hostKey;
        const agents = catalogAgents(remoteModelCatalogs[host.hostKey]);
        const permission = permissionOptions(config?.agent);
        return (
          <div key={host.hostKey} className="sidebar-remote-launch-host">
            <div className="sidebar-remote-launch-row">
              <TooltipButton
                type="button"
                className="sidebar-remote-launch-create"
                tooltip={host.connected
                  ? t("remote:newRemoteSessionOn", { label: host.label })
                  : t("remote:offlineHost", { label: host.label })}
                ariaLabel={t("remote:newRemoteSessionOn", { label: host.label })}
                aria-expanded={open}
                disabled={busy !== null}
                onClick={() => void openConfig(host)}
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
            {open && config ? (
              <div className="sidebar-remote-launch-config" role="group" aria-label={t("remote:newRemoteSessionOn", { label: host.label })}>
                {agents.length > 1 ? (
                  <div className="sidebar-remote-launch-field">
                    <span className="sidebar-remote-launch-field-label">{t("remote:chooseAgent")}</span>
                    <SettingsMenuSelect
                      label={t("remote:chooseAgent")}
                      value={config.agent ?? ""}
                      options={[
                        ...(config.agent ? [] : [{ id: "", label: t("remote:chooseAgent"), disabled: true }]),
                        ...agents.map((agent) => ({ id: agent, label: agent })),
                      ]}
                      onChange={(agent) => {
                        const catalog = REMOTE_AGENT_PERMISSION_CATALOG[agent];
                        setConfig({
                          ...config,
                          agent,
                          permissionMode: catalog?.default,
                        });
                      }}
                      fullWidth
                    />
                  </div>
                ) : null}
                {permission && config?.agent ? (
                  <div className="sidebar-remote-launch-field">
                    <span className="sidebar-remote-launch-field-label">{t("chat.permissionMode")}</span>
                    <SettingsMenuSelect
                      label={t("chat.permissionMode")}
                      value={config.permissionMode ?? permission.default}
                      options={permission.options.map((option) => ({
                        id: option,
                        label: permissionLabel(config.agent, option)
                          + (option === permission.default ? ` (${t("remote:permissionDefault")})` : ""),
                      }))}
                      onChange={(permissionMode) => setConfig({ ...config, permissionMode })}
                      fullWidth
                    />
                  </div>
                ) : null}
                <div className="sidebar-remote-launch-field">
                  <span className="sidebar-remote-launch-field-label">{t("remote:projectFolder")}</span>
                  <span className="sidebar-remote-launch-folder">
                    <span className="sidebar-remote-launch-cwd" title={config.cwd ?? ""}>
                      {config.cwd ?? t("remote:directCreateHome")}
                    </span>
                    <Button type="button" variant="ghost" onClick={() => setBrowseHost(host)}>
                      {t("remote:browseFolders")}
                    </Button>
                  </span>
                </div>
                <div className="sidebar-remote-launch-actions">
                  <Button
                    type="button"
                    variant="primary"
                    disabled={busy !== null || (agents.length > 1 && !config.agent)}
                    onClick={() => void create(host, config)}
                  >
                    {busy === host.hostKey ? t("remote:loading") : t("remote:createRemoteSession")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {browseHost ? (
        <RemoteFolderDialog
          key={browseHost.hostKey}
          hostKey={browseHost.hostKey}
          hostLabel={browseHost.label}
          initialPath=""
          onChoose={(path) => {
            const host = browseHost;
            setBrowseHost(null);
            // Browsing from a host row opens its config with the folder set;
            // from an open config it just updates the folder.
            if (config?.hostKey === host.hostKey) {
              setConfig({ ...config, cwd: path });
            } else {
              void openConfig(host, path);
            }
          }}
          onClose={() => setBrowseHost(null)}
        />
      ) : null}
    </div>
  );
}
