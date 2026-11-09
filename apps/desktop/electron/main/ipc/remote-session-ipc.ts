import {
  IPC, PROVIDER_SYNC_MAX_PROVIDERS, RACP_PERMISSION_MODES, RACP_SESSION_MODES,
  type RemoteHostCreateSessionRequest, type RemoteHostSyncProvidersRequest,
} from "@pi-desktop/shared";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts.js";
import type { IpcRegistrar } from "./types.js";

function invalid(field: string): never {
  throw Object.assign(new Error(`invalid ${field}`), { errorCode: "INVALID_ARGUMENT", field });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("request");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) invalid(field);
  return value.trim();
}
function hostKey(input: Record<string, unknown>): string {
  const key = text(input.hostKey, "hostKey", 200);
  if (key.includes(":")) invalid("hostKey");
  return key;
}

/** The remote-only entry points never dispatch arbitrary RACP method names. */
export function registerRemoteSessionIpc(registrar: IpcRegistrar, getBoot: () => RemoteHostsBoot): void {
  registrar.handle(IPC.invoke.remoteHostReconnect, async (request: unknown) => {
    const key = hostKey(object(request));
    return { host: await getBoot().reconnectHost(key) };
  });
  registrar.handle(IPC.invoke.remoteHostUpdate, async (request: unknown) => {
    const input = object(request);
    const key = hostKey(input);
    const patch: { label?: string; sshSecret?: string | null; ssh?: Record<string, unknown> } = {};
    if (typeof input.label === "string" && input.label.trim()) patch.label = text(input.label, "label", 200);
    // An empty password clears the stored one; absent leaves it alone.
    if (typeof input.password === "string") patch.sshSecret = input.password === "" ? null : input.password;
    if (input.ssh && typeof input.ssh === "object") {
      const ssh = input.ssh as Record<string, unknown>;
      // Empty-string fields clear the stored value; absent leaves it alone.
      const cleaned: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(ssh)) {
        if (value === "") (cleaned as Record<string, null>)[field] = null;
        else cleaned[field] = value;
      }
      patch.ssh = cleaned;
    }
    return { host: await getBoot().updateHost(key, patch) };
  });
  registrar.handle(IPC.invoke.remoteHostCheck, async (request: unknown) => {
    return getBoot().checkHost(hostKey(object(request)));
  });
  registrar.handle(IPC.invoke.remoteHostProjects, async (request: unknown) => {
    return { projects: await getBoot().projects(hostKey(object(request))) };
  });
  registrar.handle(IPC.invoke.remoteHostModels, async (request: unknown) => {
    return { models: await getBoot().models(hostKey(object(request))) };
  });
  registrar.handle(IPC.invoke.remoteHostBrowseProjects, async (request: unknown) => {
    const input = object(request);
    const key = hostKey(input);
    const path = input.path === undefined ? undefined : text(input.path, "path", 4096);
    if (path !== undefined && !path.startsWith("/")) invalid("path");
    return getBoot().browseProjects(key, path);
  });
  registrar.handle(IPC.invoke.remoteHostSessions, async (request: unknown) => {
    return { sessions: await getBoot().sessions(hostKey(object(request))) };
  });
  registrar.handle(IPC.invoke.remoteHostRegisterProject, async (request: unknown) => {
    const input = object(request);
    const key = hostKey(input);
    const path = text(input.path, "path", 4096);
    if (!path.startsWith("/")) invalid("path");
    return { project: await getBoot().registerProject(key, path) };
  });
  registrar.handle(IPC.invoke.remoteHostCreateSession, async (request: unknown) => {
    const input = object(request);
    const key = hostKey(input);
    const projectId = text(input.projectId, "projectId", 256);
    const title = input.title === undefined ? undefined : text(input.title, "title", 200);
    if (input.mode !== undefined && !(RACP_SESSION_MODES as readonly unknown[]).includes(input.mode)) invalid("mode");
    if (input.permissionMode !== undefined && !(RACP_PERMISSION_MODES as readonly unknown[]).includes(input.permissionMode)) invalid("permissionMode");
    const parsed: RemoteHostCreateSessionRequest = {
      hostKey: key, projectId, ...(title ? { title } : {}),
      ...(input.mode ? { mode: input.mode as RemoteHostCreateSessionRequest["mode"] } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode as RemoteHostCreateSessionRequest["permissionMode"] } : {}),
      ...(typeof input.provider === "string" && input.provider.trim() ? { provider: text(input.provider, "provider", 64) } : {}),
      ...(typeof input.model === "string" && input.model.trim() ? { model: text(input.model, "model", 200) } : {}),
    };
    return { session: await getBoot().createSession(parsed) };
  });
  registrar.handle(IPC.invoke.remoteHostSyncProviders, async (request: unknown) => {
    const input = object(request);
    const key = hostKey(input);
    if (!Array.isArray(input.providerIds) || input.providerIds.length < 1 || input.providerIds.length > PROVIDER_SYNC_MAX_PROVIDERS) invalid("providerIds");
    const providerIds = input.providerIds.map((id: unknown) => text(id, "providerIds", 256));
    if (new Set(providerIds).size !== providerIds.length) invalid("providerIds");
    if (typeof input.setDefault !== "boolean") invalid("setDefault");
    const parsed: RemoteHostSyncProvidersRequest = { hostKey: key, providerIds, setDefault: input.setDefault };
    return getBoot().syncProviders(parsed);
  });
}
