/**
 * Built-in CDE providers.
 *
 * Token-based providers (Autodesk, SharePoint, OneDrive, Google Drive,
 * Dropbox) expect a bearer token that the user has already obtained. This
 * is deliberate: a pure browser app cannot perform an OAuth authorization
 * code flow without a server to hold the client secret.
 *
 * WebDAV is fully self-contained — it speaks the protocol directly with
 * HTTP Basic auth, so it works against Nextcloud, ownCloud, SharePoint on
 * premises, IIS, Apache mod_dav, or any standards-compliant DAV server.
 */
import {
  registerCdeProvider,
} from "./registry";
import type {
  CdeCredentials,
  CdeFile,
  CdeFolder,
  CdeProject,
  CdeProvider,
  CdeProviderMeta,
  CdeSession,
} from "./types";

/* ══════════════════════════════════════════════════════════════════════════
   Shared helpers
   ══════════════════════════════════════════════════════════════════════════ */

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

async function httpError(res: Response, label: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  const trimmed = body.length > 240 ? `${body.slice(0, 240)}…` : body;
  return new Error(
    `${label} ${res.status} ${res.statusText}` +
      (trimmed ? `\n\n${trimmed}` : ""),
  );
}

function bearer(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* ══════════════════════════════════════════════════════════════════════════
   Autodesk Platform Services (APS) / BIM 360
   ══════════════════════════════════════════════════════════════════════════ */

const AUTODESK_META: CdeProviderMeta = {
  id: "autodesk",
  label: "Autodesk Platform Services",
  description:
    "Access BIM 360 / ACC hubs, projects, folders and files via the " +
    "Autodesk Platform Services Data Management API. Paste a valid " +
    "3-legged or 2-legged OAuth token.",
  icon: "🅰",
  pushEnabled: true,
  issuesEnabled: false,
  credentialFields: [
    {
      key: "token",
      label: "Access token",
      type: "password",
      required: true,
      placeholder: "eyJhbGciOi…",
      hint:
        "Get a token from the APS developer portal or your OAuth flow. " +
        "Tokens expire after 60 minutes.",
    },
    {
      key: "region",
      label: "Region",
      type: "text",
      required: false,
      defaultValue: "US",
      hint: "US, EMEA, or APAC. Defaults to US.",
    },
  ],
};

const autodeskProvider: CdeProvider = {
  meta: AUTODESK_META,

  async authenticate(creds) {
    const token = (creds.token ?? "").trim();
    if (!token) throw new Error("An access token is required.");
    return {
      providerId: "autodesk",
      accessToken: token,
      extra: { region: (creds.region ?? "US").toUpperCase() },
    };
  },

  async listProjects(session) {
    const region = String(session.extra?.region ?? "US");
    const host =
      region === "EMEA" ? "https://developer.api.autodesk.com"
      : region === "APAC" ? "https://developer.api.autodesk.com"
      : "https://developer.api.autodesk.com";
    const url = joinUrl(host, "/project/v1/hubs");
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "Autodesk hubs");
    const json: any = await res.json();
    const hubs: any[] = json?.data ?? [];

    const projects: CdeProject[] = [];
    for (const hub of hubs) {
      const href: string = hub?.relationships?.projects?.links?.related?.href;
      if (!href) continue;
      const pr = await fetch(href, { headers: bearer(session.accessToken) });
      if (!pr.ok) continue;
      const pj: any = await pr.json();
      for (const p of pj?.data ?? []) {
        projects.push({
          id: `${hub.id}::${p.id}`,
          name: p?.attributes?.name ?? p.id,
          description: `Hub ${hub?.attributes?.name ?? hub.id}`,
        });
      }
    }
    return projects;
  },

  async listFolders(session, projectId, parentFolderId) {
    const [hubId, projectIdOnly] = projectId.split("::");
    if (!hubId || !projectIdOnly) {
      throw new Error("Autodesk project id is malformed.");
    }
    const url = joinUrl(
      "https://developer.api.autodesk.com",
      `/data/v1/projects/${encodeURIComponent(projectIdOnly ?? "")}/folders` +
        (parentFolderId ? `/${encodeURIComponent(parentFolderId)}/contents` : ""),
    );
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "Autodesk folders");
    const json: any = await res.json();
    const out: CdeFolder[] = [];
    for (const item of json?.data ?? []) {
      if (item?.type !== "folders") continue;
      out.push({
        id: item.id,
        name: item?.attributes?.displayName ?? item.id,
        parentId: parentFolderId ?? null,
        updatedAt: item?.attributes?.lastModifiedTime
          ? Date.parse(item.attributes.lastModifiedTime) || undefined
          : undefined,
      });
    }
    return out;
  },

  async listFiles(session, projectId, folderId) {
    const [, projectIdOnly] = projectId.split("::");
    if (!projectIdOnly) throw new Error("Invalid ACC project id");
    const url = joinUrl(
      "https://developer.api.autodesk.com",
      `/data/v1/projects/${encodeURIComponent(projectIdOnly ?? "")}` +
        `/folders/${encodeURIComponent(folderId ?? "")}/contents`,
    );
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "Autodesk files");
    const json: any = await res.json();
    const out: CdeFile[] = [];
    for (const item of json?.data ?? []) {
      if (item?.type !== "items") continue;
      const versionId: string | undefined =
        item?.relationships?.tip?.data?.id;
      if (!versionId) continue;
      out.push({
        id: versionId,
        name: item?.attributes?.displayName ?? item.id,
        size: item?.attributes?.storageSize ?? undefined,
        mimeType: item?.attributes?.fileType ?? undefined,
        updatedAt: item?.attributes?.lastModifiedTime
          ? Date.parse(item.attributes.lastModifiedTime) || undefined
          : undefined,
      });
    }
    return out;
  },

  async downloadFile(session, _projectId, versionId) {
    const url = joinUrl(
      "https://developer.api.autodesk.com",
      `/data/v1/versions/${encodeURIComponent(versionId)}/downloadurl`,
    );
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "Autodesk download url");
    const json: any = await res.json();
    const signed = json?.url;
    if (!signed) throw new Error("Autodesk returned no download URL.");
    const bin = await fetch(signed);
    if (!bin.ok) throw await httpError(bin, "Autodesk download");
    return bin.blob();
  },

  async uploadFile(session, projectId, folderId, filename, data) {
    const [, projectIdOnly] = projectId.split("::");
    if (!projectIdOnly) throw new Error("Invalid ACC project id");
    const url = joinUrl(
      "https://developer.api.autodesk.com",
      `/data/v1/projects/${encodeURIComponent(projectIdOnly ?? "")}` +
        `/folders/${encodeURIComponent(folderId ?? "")}/items`,
    );
    const body = {
      jsonapi: { version: "1.0" },
      data: {
        type: "items",
        attributes: {
          displayName: filename,
          extension: { type: "items:autodesk.bim360:File", version: "1.0" },
        },
        relationships: {
          tip: { data: { type: "versions", id: "1" } },
          parent: { data: { type: "folders", id: folderId } },
        },
      },
      included: [
        {
          type: "versions",
          id: "1",
          attributes: {
            name: filename,
            extension: { type: "versions:autodesk.bim360:File", version: "1.0" },
          },
        },
      ],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json", ...bearer(session.accessToken) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res, "Autodesk create item");
    const created: any = await res.json();
    const itemId = created?.data?.id;
    if (!itemId) throw new Error("Autodesk did not return a new item id.");

    // Now push the binary.
    const storageUrl = joinUrl(
      "https://developer.api.autodesk.com",
      `/data/v1/projects/${encodeURIComponent(projectIdOnly ?? "")}` +
        `/items/${encodeURIComponent(itemId)}/versions/1/storage`,
    );
    const storageRes = await fetch(storageUrl, { headers: bearer(session.accessToken) });
    if (!storageRes.ok) throw await httpError(storageRes, "Autodesk storage");
    const storageJson: any = await storageRes.json();
    const signed: string | undefined =
      storageJson?.data?.attributes?.uploadLink ??
      storageJson?.data?.relationships?.storage?.links?.upload;
    if (!signed) throw new Error("Autodesk returned no upload link.");

    const put = await fetch(signed, { method: "PUT", body: data });
    if (!put.ok) throw await httpError(put, "Autodesk upload");

    return { id: itemId, name: filename, size: data.size };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   SharePoint (Graph API)
   ══════════════════════════════════════════════════════════════════════════ */

const SHAREPOINT_META: CdeProviderMeta = {
  id: "sharepoint",
  label: "SharePoint",
  description:
    "Access SharePoint document libraries via the Microsoft Graph API. " +
    "Paste a bearer token issued for the Graph scope Files.ReadWrite.All " +
    "(or Sites.Read.All for read-only access).",
  icon: "🟦",
  pushEnabled: true,
  issuesEnabled: false,
  credentialFields: [
    {
      key: "token",
      label: "Graph access token",
      type: "password",
      required: true,
      placeholder: "eyJ0eXAiOiJKV1Qi…",
      hint:
        "Get a token from the Microsoft Graph Explorer, or your own " +
        "OAuth flow. Tokens last about 60 minutes.",
    },
    {
      key: "siteId",
      label: "Site id",
      type: "text",
      required: false,
      placeholder: "contoso.sharepoint.com,abcd-…,efgh-…",
      hint:
        "Optional. Leave blank to browse all sites you have access to.",
    },
  ],
};

const sharepointProvider: CdeProvider = {
  meta: SHAREPOINT_META,

  async authenticate(creds) {
    const token = (creds.token ?? "").trim();
    if (!token) throw new Error("A Graph access token is required.");
    return {
      providerId: "sharepoint",
      accessToken: token,
      extra: { siteId: creds.siteId || undefined },
    };
  },

  async listProjects(session) {
    const siteId = session.extra?.siteId as string | undefined;
    if (siteId) {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}`,
        { headers: bearer(session.accessToken) },
      );
      if (!res.ok) throw await httpError(res, "SharePoint site");
      const s: any = await res.json();
      return [{ id: s.id, name: s.displayName || s.name || s.id }];
    }
    const res = await fetch(
      "https://graph.microsoft.com/v1.0/sites?search=*",
      { headers: bearer(session.accessToken) },
    );
    if (!res.ok) throw await httpError(res, "SharePoint sites");
    const json: any = await res.json();
    return (json?.value ?? []).map((s: any) => ({
      id: s.id,
      name: s.displayName || s.name || s.id,
      description: s.webUrl,
    }));
  },

  async listFolders(session, siteId, parentFolderId) {
    const root = parentFolderId
      ? `/sites/${encodeURIComponent(siteId)}/drive/items/${encodeURIComponent(parentFolderId)}/children`
      : `/sites/${encodeURIComponent(siteId)}/drive/root/children`;
    const res = await fetch(`https://graph.microsoft.com/v1.0${root}`, {
      headers: bearer(session.accessToken),
    });
    if (!res.ok) throw await httpError(res, "SharePoint folders");
    const json: any = await res.json();
    return (json?.value ?? [])
      .filter((x: any) => x.folder)
      .map((x: any) => ({
        id: x.id,
        name: x.name,
        parentId: parentFolderId ?? null,
        updatedAt: x.lastModifiedDateTime ? Date.parse(x.lastModifiedDateTime) : undefined,
      }));
  },

  async listFiles(session, siteId, folderId) {
    const url = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/drive/items/${encodeURIComponent(folderId ?? "")}/children`;
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "SharePoint files");
    const json: any = await res.json();
    return (json?.value ?? [])
      .filter((x: any) => x.file)
      .map((x: any) => ({
        id: x.id,
        name: x.name,
        size: x.size,
        mimeType: x.file?.mimeType,
        updatedAt: x.lastModifiedDateTime ? Date.parse(x.lastModifiedDateTime) : undefined,
      }));
  },

  async downloadFile(session, siteId, fileId) {
    const url = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/drive/items/${encodeURIComponent(fileId)}/content`;
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "SharePoint download");
    return res.blob();
  },

  async uploadFile(session, siteId, folderId, filename, data) {
    const url =
      `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}` +
      `/drive/items/${encodeURIComponent(folderId ?? "")}:/${encodeURIComponent(filename)}:/content`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", ...bearer(session.accessToken) },
      body: data,
    });
    if (!res.ok) throw await httpError(res, "SharePoint upload");
    const json: any = await res.json();
    return { id: json.id, name: json.name, size: json.size };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   OneDrive (Graph API, personal)
   ══════════════════════════════════════════════════════════════════════════ */

const ONEDRIVE_META: CdeProviderMeta = {
  id: "onedrive",
  label: "OneDrive",
  description:
    "Access OneDrive via the Microsoft Graph API. Same token as " +
    "SharePoint, but the drive is the signed-in user's personal drive.",
  icon: "🟦",
  pushEnabled: true,
  issuesEnabled: false,
  credentialFields: [
    {
      key: "token",
      label: "Graph access token",
      type: "password",
      required: true,
      hint: "Scope: Files.ReadWrite.All",
    },
  ],
};

const onedriveProvider: CdeProvider = {
  meta: ONEDRIVE_META,

  async authenticate(creds) {
    const token = (creds.token ?? "").trim();
    if (!token) throw new Error("A Graph access token is required.");
    return { providerId: "onedrive", accessToken: token };
  },

  async listProjects() {
    // OneDrive has a single implicit project: "My Drive".
    return [{ id: "me", name: "My Drive" }];
  },

  async listFolders(session, _projectId, parentFolderId) {
    const path = parentFolderId
      ? `/me/drive/items/${encodeURIComponent(parentFolderId)}/children`
      : "/me/drive/root/children";
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      headers: bearer(session.accessToken),
    });
    if (!res.ok) throw await httpError(res, "OneDrive folders");
    const json: any = await res.json();
    return (json?.value ?? [])
      .filter((x: any) => x.folder)
      .map((x: any) => ({
        id: x.id,
        name: x.name,
        parentId: parentFolderId ?? null,
        updatedAt: x.lastModifiedDateTime ? Date.parse(x.lastModifiedDateTime) : undefined,
      }));
  },

  async listFiles(session, _projectId, folderId) {
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId ?? "")}/children`;
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "OneDrive files");
    const json: any = await res.json();
    return (json?.value ?? [])
      .filter((x: any) => x.file)
      .map((x: any) => ({
        id: x.id,
        name: x.name,
        size: x.size,
        mimeType: x.file?.mimeType,
        updatedAt: x.lastModifiedDateTime ? Date.parse(x.lastModifiedDateTime) : undefined,
      }));
  },

  async downloadFile(session, _projectId, fileId) {
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}/content`;
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "OneDrive download");
    return res.blob();
  },

  async uploadFile(session, _projectId, folderId, filename, data) {
    const url =
      `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId ?? "")}` +
      `:/${encodeURIComponent(filename)}:/content`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", ...bearer(session.accessToken) },
      body: data,
    });
    if (!res.ok) throw await httpError(res, "OneDrive upload");
    const json: any = await res.json();
    return { id: json.id, name: json.name, size: json.size };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   Google Drive
   ══════════════════════════════════════════════════════════════════════════ */

const GDRIVE_META: CdeProviderMeta = {
  id: "googledrive",
  label: "Google Drive",
  description:
    "Access Google Drive via the Drive v3 API. Paste an OAuth token with " +
    "scope drive.readonly (read) or drive.file (read + upload).",
  icon: "🟢",
  pushEnabled: true,
  issuesEnabled: false,
  credentialFields: [
    {
      key: "token",
      label: "Access token",
      type: "password",
      required: true,
      placeholder: "ya29.a0…",
      hint: "Get one from OAuth 2.0 Playground with the Drive scope.",
    },
  ],
};

const gdriveProvider: CdeProvider = {
  meta: GDRIVE_META,

  async authenticate(creds) {
    const token = (creds.token ?? "").trim();
    if (!token) throw new Error("A Drive access token is required.");
    return { providerId: "googledrive", accessToken: token };
  },

  async listProjects() {
    return [{ id: "root", name: "My Drive" }];
  },

  async listFolders(session, _projectId, parentFolderId) {
    const q = `'${parentFolderId ?? "root"}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "files(id,name,modifiedTime)");
    url.searchParams.set("pageSize", "200");
    const res = await fetch(url.toString(), { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "Drive folders");
    const json: any = await res.json();
    return (json?.files ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      parentId: parentFolderId ?? null,
      updatedAt: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined,
    }));
  },

  async listFiles(session, _projectId, folderId) {
    const q = `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "files(id,name,size,mimeType,modifiedTime)");
    url.searchParams.set("pageSize", "200");
    const res = await fetch(url.toString(), { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "Drive files");
    const json: any = await res.json();
    return (json?.files ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      size: f.size ? Number(f.size) : undefined,
      mimeType: f.mimeType,
      updatedAt: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined,
    }));
  },

  async downloadFile(session, _projectId, fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await fetch(url, { headers: bearer(session.accessToken) });
    if (!res.ok) throw await httpError(res, "Drive download");
    return res.blob();
  },

  async uploadFile(session, _projectId, folderId, filename, data) {
    const metadata = { name: filename, parents: [folderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", data, filename);
    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      { method: "POST", headers: bearer(session.accessToken), body: form },
    );
    if (!res.ok) throw await httpError(res, "Drive upload");
    const json: any = await res.json();
    return { id: json.id, name: json.name };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   Dropbox
   ══════════════════════════════════════════════════════════════════════════ */

const DROPBOX_META: CdeProviderMeta = {
  id: "dropbox",
  label: "Dropbox",
  description:
    "Access Dropbox via the Dropbox API v2. Paste an access token with " +
    "files.content.read and files.content.write scopes.",
  icon: "🔵",
  pushEnabled: true,
  issuesEnabled: false,
  credentialFields: [
    {
      key: "token",
      label: "Access token",
      type: "password",
      required: true,
      placeholder: "sl.AbCdEf…",
      hint: "Create one at dropbox.com/developers/apps.",
    },
  ],
};

const dropboxProvider: CdeProvider = {
  meta: DROPBOX_META,

  async authenticate(creds) {
    const token = (creds.token ?? "").trim();
    if (!token) throw new Error("A Dropbox access token is required.");
    return { providerId: "dropbox", accessToken: token };
  },

  async listProjects() {
    return [{ id: "root", name: "Dropbox" }];
  },

  async listFolders(session, _projectId, parentFolderId) {
    const path = parentFolderId ?? "";
    const res = await fetch(
      "https://api.dropboxapi.com/2/files/list_folder",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...bearer(session.accessToken),
        },
        body: JSON.stringify({ path, recursive: false }),
      },
    );
    if (!res.ok) throw await httpError(res, "Dropbox folders");
    const json: any = await res.json();
    return (json?.entries ?? [])
      .filter((e: any) => e[".tag"] === "folder")
      .map((e: any) => ({
        id: e.path_lower,
        name: e.name,
        parentId: parentFolderId ?? null,
      }));
  },

  async listFiles(session, _projectId, folderId) {
    const res = await fetch(
      "https://api.dropboxapi.com/2/files/list_folder",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...bearer(session.accessToken),
        },
        body: JSON.stringify({ path: folderId, recursive: false }),
      },
    );
    if (!res.ok) throw await httpError(res, "Dropbox files");
    const json: any = await res.json();
    return (json?.entries ?? [])
      .filter((e: any) => e[".tag"] === "file")
      .map((e: any) => ({
        id: e.path_lower,
        name: e.name,
        size: e.size,
        updatedAt: e.server_modified ? Date.parse(e.server_modified) : undefined,
      }));
  },

  async downloadFile(session, _projectId, fileId) {
    const res = await fetch(
      "https://content.dropboxapi.com/2/files/download",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Dropbox-API-Arg": JSON.stringify({ path: fileId }),
        },
      },
    );
    if (!res.ok) throw await httpError(res, "Dropbox download");
    return res.blob();
  },

  async uploadFile(session, _projectId, folderId, filename, data) {
    const path = folderId === "/" ? `/${filename}` : `${folderId}/${filename}`;
    const res = await fetch(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path,
            mode: "overwrite",
            autorename: false,
            mute: true,
          }),
        },
        body: data,
      },
    );
    if (!res.ok) throw await httpError(res, "Dropbox upload");
    const json: any = await res.json();
    return { id: json.path_lower, name: json.name, size: json.size };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   Generic WebDAV
   ══════════════════════════════════════════════════════════════════════════ */

const WEBDAV_META: CdeProviderMeta = {
  id: "webdav",
  label: "WebDAV",
  description:
    "Any standards-compliant WebDAV server: Nextcloud, ownCloud, " +
    "SharePoint on premises, Apache mod_dav, IIS. Uses HTTP Basic auth — " +
    "no token required.",
  icon: "🌐",
  pushEnabled: true,
  issuesEnabled: false,
  credentialFields: [
    {
      key: "endpoint",
      label: "Server URL",
      type: "url",
      required: true,
      placeholder: "https://cloud.example.com/remote.php/dav/files/me",
      hint: "The base path of the DAV share.",
    },
    {
      key: "username",
      label: "Username",
      type: "text",
      required: true,
      placeholder: "alice",
    },
    {
      key: "password",
      label: "Password",
      type: "password",
      required: true,
      hint:
        "For Nextcloud/ownCloud, generate an app-specific password " +
        "rather than using your account password.",
    },
  ],
};

function basicAuth(user: string, pass: string): string {
  // btoa on Latin-1 only. Encode UTF-8 first so non-ASCII passwords work.
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

function parseDavResponse(xml: string, baseUrl: string): {
  href: string;
  name: string;
  isFolder: boolean;
  size?: number;
  modified?: number;
}[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const responses = Array.from(doc.getElementsByTagNameNS("*", "response"));
  const out: ReturnType<typeof parseDavResponse> = [];

  for (const r of responses) {
    const hrefEl = r.getElementsByTagNameNS("*", "href")[0];
    const href = hrefEl?.textContent ?? "";
    if (!href) continue;

    // The first entry is the collection itself — skip it.
    const isCollection = r.getElementsByTagNameNS("*", "collection").length > 0;
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch { /* */ }
    // Strip trailing slash so the basename logic is uniform.
    const trimmed = decoded.replace(/\/+$/, "");
    const name = trimmed.split("/").pop() ?? "";

    const sizeEl = r.getElementsByTagNameNS("*", "getcontentlength")[0];
    const size = sizeEl?.textContent ? Number(sizeEl.textContent) : undefined;

    const modEl = r.getElementsByTagNameNS("*", "getlastmodified")[0];
    const modified = modEl?.textContent ? Date.parse(modEl.textContent) : undefined;

    // Absolute-ize the href against the base URL.
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      absolute = href;
    }

    out.push({ href: absolute, name, isFolder: isCollection, size, modified });
  }

  // Strip the collection self-entry (first response with no name).
  return out.filter((e) => e.name !== "");
}

const webdavProvider: CdeProvider = {
  meta: WEBDAV_META,

  async authenticate(creds) {
    const endpoint = (creds.endpoint ?? "").trim().replace(/\/+$/, "");
    const username = (creds.username ?? "").trim();
    const password = creds.password ?? "";
    if (!endpoint) throw new Error("A server URL is required.");
    if (!username) throw new Error("A username is required.");
    if (!password) throw new Error("A password is required.");

    // Validate by requesting the root collection.
    const res = await fetch(endpoint + "/", {
      method: "PROPFIND",
      headers: {
        Authorization: basicAuth(username, password),
        Depth: "0",
        "Content-Type": "application/xml",
      },
      body:
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
    });
    if (!res.ok) throw await httpError(res, "WebDAV authenticate");

    return {
      providerId: "webdav",
      user: { name: username },
      extra: {
        endpoint,
        auth: basicAuth(username, password),
      },
    };
  },

  async listProjects(session) {
    const endpoint = String(session.extra?.endpoint ?? "");
    return [{ id: endpoint, name: "WebDAV share", description: endpoint }];
  },

  async listFolders(session, _projectId, parentFolderId) {
    const endpoint = String(session.extra?.endpoint ?? "");
    const auth = String(session.extra?.auth ?? "");
    const target = parentFolderId || endpoint;

    const res = await fetch(target.endsWith("/") ? target : target + "/", {
      method: "PROPFIND",
      headers: { Authorization: auth, Depth: "1" },
    });
    if (!res.ok) throw await httpError(res, "WebDAV folders");
    const xml = await res.text();
    const entries = parseDavResponse(xml, target);
    return entries
      .filter((e) => e.isFolder)
      .map((e) => ({
        id: e.href,
        name: e.name,
        parentId: parentFolderId ?? null,
        updatedAt: e.modified,
      }));
  },

  async listFiles(session, _projectId, folderId) {
    const auth = String(session.extra?.auth ?? "");
    const res = await fetch((folderId ?? "").endsWith("/") ? (folderId ?? "") : (folderId ?? "") + "/", {
      method: "PROPFIND",
      headers: { Authorization: auth, Depth: "1" },
    });
    if (!res.ok) throw await httpError(res, "WebDAV files");
    const xml = await res.text();
    const entries = parseDavResponse(xml, folderId ?? "");
    return entries
      .filter((e) => !e.isFolder)
      .map((e) => ({
        id: e.href,
        name: e.name,
        size: e.size,
        updatedAt: e.modified,
      }));
  },

  async downloadFile(session, _projectId, fileId) {
    const auth = String(session.extra?.auth ?? "");
    const res = await fetch(fileId, { headers: { Authorization: auth } });
    if (!res.ok) throw await httpError(res, "WebDAV download");
    return res.blob();
  },

  async uploadFile(session, _projectId, folderId, filename, data) {
    const auth = String(session.extra?.auth ?? "");
    const target =
      (folderId.endsWith("/") ? folderId : folderId + "/") +
      encodeURIComponent(filename);
    const res = await fetch(target, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    if (!res.ok) throw await httpError(res, "WebDAV upload");
    return { id: target, name: filename, size: data.size };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   Registration
   ══════════════════════════════════════════════════════════════════════════ */

let registered = false;

/**
 * Register every built-in provider. Safe to call more than once.
 * Idempotent so the CDE panel and the AI tools can both call it during
 * boot without producing duplicate entries.
 */
export function registerCdeProviders(): void {
  if (registered) return;
  registered = true;

  registerCdeProvider(autodeskProvider);
  registerCdeProvider(sharepointProvider);
  registerCdeProvider(onedriveProvider);
  registerCdeProvider(gdriveProvider);
  registerCdeProvider(dropboxProvider);
  registerCdeProvider(webdavProvider);

  console.log("[cde] 6 providers registered");
}