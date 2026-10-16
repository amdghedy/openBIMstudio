/**
 * SharePoint / OneDrive provider (Microsoft Graph).
 *
 * Uses delegated permissions. The user pastes an OAuth access token for
 * the Microsoft Graph API with `Files.ReadWrite.All` scope.
 *
 * To obtain a token interactively, use the Microsoft Graph Explorer
 * (developer.microsoft.com/graph/graph-explorer) and sign in with the
 * account that owns the SharePoint site.
 *
 * Required credentials:
 *   • accessToken — Graph API token
 *   • siteId      — SharePoint site ID (e.g. contoso.sharepoint.com,<guid>,<guid>)
 *                   Leave blank to use the signed-in user's OneDrive.
 */
import { requestJson, requestRaw } from "../http";
import type {
  CdeCredentials, CdeFile, CdeFolder, CdeIssue, CdeProject, CdeProvider,
  CdeProviderId, CdeProviderMeta, CdeSession,
} from "../types";

const GRAPH = "https://graph.microsoft.com/v1.0";

export const SHAREPOINT_META: CdeProviderMeta = {
  id: "sharepoint",
  label: "SharePoint / OneDrive",
  description:
    "Microsoft Graph — pull and push files via SharePoint document libraries " +
    "or OneDrive for Business. Issues are written as .bcfzip attachments.",
  icon: "◈",
  pushEnabled: true,
  issuesEnabled: false, // issues are pushed as BCF files, not native issues
  credentialFields: [
    {
      key: "accessToken",
      label: "Graph access token",
      type: "password",
      required: true,
      hint:
        "From graph.microsoft.com → Graph Explorer → sign in → copy the " +
        "access token. Scope: Files.ReadWrite.All",
    },
    {
      key: "siteId",
      label: "SharePoint site ID",
      type: "text",
      required: false,
      placeholder: "contoso.sharepoint.com,abc…,def…",
      hint: "Leave blank to use the user's personal OneDrive.",
    },
  ],
};

function auth(session: CdeSession): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function driveRoot(session: CdeSession): string {
  const siteId = session.refreshToken;
  return siteId
    ? `${GRAPH}/sites/${siteId}/drive`
    : `${GRAPH}/me/drive`;
}

export const sharepointProvider: CdeProvider = {
  id: "sharepoint",

  async authenticate(credentials: CdeCredentials): Promise<CdeSession> {
    const token = (credentials.accessToken ?? "").trim();
    const siteId = (credentials.siteId ?? "").trim();
    if (!token) throw new Error("Graph access token is required.");
    const me = await requestJson<any>(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      providerId: "sharepoint",
      accessToken: token,
      refreshToken: siteId || undefined,
      user: {
        name: me?.displayName ?? "Graph user",
        email: me?.mail ?? me?.userPrincipalName,
      },
      expiresAt: Date.now() + 55 * 60 * 1000,
    };
  },

  async listProjects(session): Promise<CdeProject[]> {
    // Every SharePoint site's default drive is treated as a "project".
    if (session.refreshToken) {
      // single site
      const site = await requestJson<any>(
        `${GRAPH}/sites/${session.refreshToken}`,
        { headers: auth(session) },
      );
      return [{
        id: site.id,
        name: site.displayName ?? site.name ?? site.id,
        description: site.webUrl,
      }];
    }
    // List sites the user has access to
    const sites = await requestJson<any>(`${GRAPH}/sites?search=*`, {
      headers: auth(session),
    });
    const out: CdeProject[] = [];
    for (const s of sites?.value ?? []) {
      out.push({ id: s.id, name: s.displayName ?? s.name ?? s.id, description: s.webUrl });
    }
    return out;
  },

  async listFolders(session, projectId, parentId): Promise<CdeFolder[]> {
    const root = parentId
      ? `${GRAPH}/sites/${projectId}/drive/items/${parentId}/children`
      : `${GRAPH}/sites/${projectId}/drive/root/children`;
    const json = await requestJson<any>(root, { headers: auth(session) });
    const out: CdeFolder[] = [];
    for (const item of json?.value ?? []) {
      if (!item.folder) continue;
      out.push({
        id: item.id,
        name: item.name,
        parentId: parentId ?? null,
        path: item.parentReference?.path,
      });
    }
    return out;
  },

  async listFiles(session, projectId, folderId): Promise<CdeFile[]> {
    const url = folderId
      ? `${GRAPH}/sites/${projectId}/drive/items/${folderId}/children`
      : `${GRAPH}/sites/${projectId}/drive/root/children`;
    const json = await requestJson<any>(url, { headers: auth(session) });
    const out: CdeFile[] = [];
    for (const item of json?.value ?? []) {
      if (!item.file) continue;
      out.push({
        id: item.id,
        name: item.name,
        size: item.size,
        updatedAt: Date.parse(item.lastModifiedDateTime ?? "") || undefined,
        folderId,
        mimeType: item.file.mimeType,
      });
    }
    return out;
  },

  async downloadFile(session, projectId, fileId): Promise<Blob> {
    const url = `${GRAPH}/sites/${projectId}/drive/items/${fileId}/content`;
    const res = await requestRaw(url, { headers: auth(session) });
    return await res.blob();
  },

  async uploadFile(session, projectId, folderId, name, data): Promise<CdeFile> {
    // Simple upload supports files up to 4 MB. For larger, we would need an
    // upload session — kept simple here for the common .ifc / .obs.json case.
    if (data.size > 4 * 1024 * 1024) {
      throw new Error(
        `File is ${(data.size / 1e6).toFixed(1)} MB. Graph simple upload ` +
        `supports up to 4 MB. Split or compress the file first.`,
      );
    }
    const url = `${GRAPH}/sites/${projectId}/drive/items/${folderId}:/${encodeURIComponent(name)}:/content`;
    const res = await requestRaw(url, {
      method: "PUT",
      headers: { ...auth(session), "Content-Type": "application/octet-stream" },
      body: data,
      raw: true,
    });
    const json = await res.json();
    return {
      id: json?.id ?? "",
      name: json?.name ?? name,
      size: json?.size ?? data.size,
      updatedAt: Date.now(),
      folderId,
    };
  },
};