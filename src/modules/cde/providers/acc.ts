/**
 * Autodesk Construction Cloud / BIM 360 provider.
 *
 * Uses the Autodesk Platform Services (APS / Forge) Data Management API:
 *   • OAuth 2.0 3-legged flow — user pastes an access token generated from
 *     a small helper script (see docs), OR uses a server-side proxy for the
 *     full flow. In this module we accept a pasted access token, which is
 *     the most common integration pattern for desktop-like tools.
 *
 * Required credentials:
 *   • accessToken — APS access token (auto-expires after ~1 hour)
 *
 * Endpoints used:
 *   • GET /project/v1/hubs                     — list hubs
 *   • GET /project/v1/hubs/:hubId/projects     — list projects in a hub
 *   • GET /data/v1/projects/:projectId/folders/:folderId/contents
 *   • GET /data/v1/projects/:projectId/items/:itemId
 */
import { requestJson, requestRaw } from "../http";
import type {
  CdeCredentials, CdeFile, CdeFolder, CdeIssue, CdeProject, CdeProvider,
  CdeProviderId, CdeProviderMeta, CdeSession,
} from "../types";

const BASE = "https://developer.api.autodesk.com";

export const ACC_META: CdeProviderMeta = {
  id: "acc",
  label: "Autodesk Construction Cloud",
  description:
    "BIM 360 / ACC — pull the latest model revision from a Docs folder, " +
    "or push issues back to the project.",
  icon: "🏗",
  pushEnabled: true,
  issuesEnabled: true,
  credentialFields: [
    {
      key: "accessToken",
      label: "Access token",
      type: "password",
      required: true,
      placeholder: "eyJhbGciOi…",
      hint:
        "Generate from the Autodesk Platform Services portal → " +
        "Your App → Get Access Token (data:read, data:write scopes).",
    },
    {
      key: "hubId",
      label: "Hub ID (optional)",
      type: "text",
      required: false,
      placeholder: "b.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      hint: "Leave blank to list hubs when signing in.",
    },
  ],
};

function authHeader(session: CdeSession): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

export const accProvider: CdeProvider = {
  id: "acc",

  async authenticate(credentials: CdeCredentials): Promise<CdeSession> {
    const token = (credentials.accessToken ?? "").trim();
    if (!token) throw new Error("Access token is required.");
    // Verify by calling /userprofile/v1/users/@me
    const user = await requestJson<any>(`${BASE}/userprofile/v1/users/@me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      providerId: "acc",
      accessToken: token,
      user: { name: user?.name ?? user?.emailId ?? "ACC user", email: user?.emailId },
      // APS tokens are opaque; we don't know exact expiry, so treat as 1h.
      expiresAt: Date.now() + 55 * 60 * 1000,
    };
  },

  async listProjects(session: CdeSession): Promise<CdeProject[]> {
    const hubs = await requestJson<any>(`${BASE}/project/v1/hubs`, {
      headers: authHeader(session),
    });
    const out: CdeProject[] = [];
    for (const hub of hubs?.data ?? []) {
      try {
        const projs = await requestJson<any>(
          `${BASE}/project/v1/hubs/${hub.id}/projects`,
          { headers: authHeader(session) },
        );
        for (const p of projs?.data ?? []) {
          out.push({
            id: `${hub.id}::${p.id}`,
            name: `${p.attributes?.name ?? p.id}  ·  ${hub.attributes?.name ?? hub.id}`,
            description: p.attributes?.extension?.data?.projectType,
          });
        }
      } catch { /* skip hubs that don't grant access */ }
    }
    return out;
  },

  async listFolders(session, projectId, parentId): Promise<CdeFolder[]> {
    const { hubId, projectId: projId } = splitId(projectId);
    const parent = parentId ?? "urn:adsk.wipprod:fs.folder:co.root";
    const url =
      `${BASE}/data/v1/projects/${projId}/folders/${encodeURIComponent(parent)}/contents`;
    const json = await requestJson<any>(url, { headers: authHeader(session) });
    const out: CdeFolder[] = [];
    for (const item of json?.data ?? []) {
      if (item.type !== "folders") continue;
      out.push({
        id: item.id,
        name: item.attributes?.displayName ?? item.id,
        parentId: parentId ?? null,
        path: item.attributes?.path,
      });
    }
    return out;
  },

  async listFiles(session, projectId, folderId): Promise<CdeFile[]> {
    const { projectId: projId } = splitId(projectId);
    const url =
      `${BASE}/data/v1/projects/${projId}/folders/${encodeURIComponent(folderId || "")}/contents`;
    const json = await requestJson<any>(url, { headers: authHeader(session) });
    const out: CdeFile[] = [];
    for (const item of json?.data ?? []) {
      if (item.type !== "items") continue;
      out.push({
        id: item.id,
        name: item.attributes?.displayName ?? item.id,
        size: item.attributes?.storageSize,
        updatedAt: Date.parse(item.attributes?.lastModifiedTime ?? "") || undefined,
        version: item.attributes?.versionNumber ? String(item.attributes.versionNumber) : undefined,
        folderId,
        mimeType: item.attributes?.mimeType,
      });
    }
    return out;
  },

  async downloadFile(session, projectId, fileId): Promise<Blob> {
    // 1. Resolve the item's tip version
    const { projectId: projId } = splitId(projectId);
    const item = await requestJson<any>(
      `${BASE}/data/v1/projects/${projId}/items/${encodeURIComponent(fileId)}/tip`,
      { headers: authHeader(session) },
    );
    const storageId = item?.data?.relationships?.storage?.data?.id;
    if (!storageId) throw new Error("Item has no storage — it may be an empty folder.");

    // 2. Ask for a signed download URL
    const signed = await requestJson<any>(
      `${BASE}/data/v1/projects/${projId}/items/${encodeURIComponent(fileId)}` +
      `?version=${item.data.id}`,
      { headers: authHeader(session) },
    );
    const dl = signed?.data?.attributes?.storageSize
      ? null
      : null; // fallback path

    // 3. Prefer the documented endpoint
    const res = await requestRaw(
      `${BASE}/data/v1/projects/${projId}/versions/${item.data.id}/downloadFormats`,
      { headers: authHeader(session) },
    );
    const formats = await res.json() as any;
    const url = formats?.data?.attributes?.formats?.[0]?.url ?? null;
    if (!url) throw new Error("Autodesk returned no download URL for this item.");

    const blob = await requestRaw(url);
    return await blob.blob();
  },

  async uploadFile(session, projectId, folderId, name, data): Promise<CdeFile> {
    const { projectId: projId } = splitId(projectId);

    // 1. Create a storage location
    const storage = await requestJson<any>(
      `${BASE}/data/v1/projects/${projId}/storage`,
      {
        method: "POST",
        headers: authHeader(session),
        body: {
          data: {
            type: "objects",
            attributes: { name },
            relationships: {
              target: { data: { type: "folders", id: folderId } },
            },
          },
        },
      },
    );
    const objectId = storage?.data?.id;
    const uploadUrl = storage?.data?.links?.upload?.href;
    if (!uploadUrl) throw new Error("Autodesk returned no upload URL.");

    // 2. PUT to the signed URL
    await requestRaw(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data,
      raw: true,
    });

    // 3. Create the item version
    const item = await requestJson<any>(
      `${BASE}/data/v1/projects/${projId}/items`,
      {
        method: "POST",
        headers: authHeader(session),
        body: {
          data: {
            type: "items",
            attributes: { displayName: name, extension: { type: "items:autodesk.bim360:File", version: "1.0" } },
            relationships: {
              tip: { data: { type: "versions", id: "1" } },
              parent: { data: { type: "folders", id: folderId } },
            },
          },
          included: [{
            type: "versions",
            id: "1",
            attributes: {
              name,
              extension: { type: "versions:autodesk.bim360:File", version: "1.0" },
            },
            relationships: {
              storage: { data: { type: "objects", id: objectId } },
            },
          }],
        },
      },
    );

    return {
      id: item?.data?.id ?? objectId,
      name,
      size: data.size,
      updatedAt: Date.now(),
      folderId,
    };
  },

  async createIssue(session, projectId, issue: CdeIssue): Promise<{ id: string; url?: string }> {
    // BIM 360 issues endpoint varies by region and product. We use the
    // generic Issues API which is available to most ACC tenants.
    const { projectId: projId } = splitId(projectId);
    const url = `${BASE}/issues/v1/containers/${projId}/issues`;
    const json = await requestJson<any>(url, {
      method: "POST",
      headers: authHeader(session),
      body: {
        title: issue.title,
        description: issue.description,
        status: issue.status ?? "open",
        assignedTo: issue.assignee,
        dueDate: issue.dueDate,
      },
    });
    return { id: json?.id ?? "", url: json?.links?.web };
  },
};

function splitId(combined: string): { hubId: string; projectId: string } {
  const [hubId, projectId] = combined.split("::");
  return { hubId: hubId ?? "", projectId: projectId ?? combined };
}