/**
 * Dalux provider.
 *
 * Dalux uses a REST API with API keys (Dalux Field / Dalux Box).
 * The user pastes:
 *   • API key (from Dalux → Account → Integrations)
 *   • Base URL (usually https://field.dalux.com/service/api)
 *
 * Documentation: https://docs.dalux.com/
 */
import { requestJson, requestRaw } from "../http";
import type {
  CdeCredentials, CdeFile, CdeFolder, CdeIssue, CdeProject, CdeProvider,
  CdeProviderId, CdeProviderMeta, CdeSession,
} from "../types";

export const DALUX_META: CdeProviderMeta = {
  id: "dalux",
  label: "Dalux",
  description:
    "Dalux Field / Dalux Box — pull models and push coordination issues.",
  icon: "◆",
  pushEnabled: true,
  issuesEnabled: true,
  credentialFields: [
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      placeholder: "paste your Dalux API key",
      hint: "Dalux → Admin → Integrations → API Keys.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      type: "url",
      required: true,
      defaultValue: "https://field.dalux.com/service/api",
    },
  ],
};

function headers(session: CdeSession): Record<string, string> {
  return { "X-API-KEY": session.accessToken ?? "" };
}

function base(session: CdeSession): string {
  return session.refreshToken ?? "https://field.dalux.com/service/api";
}

export const daluxProvider: CdeProvider = {
  id: "dalux",

  async authenticate(credentials): Promise<CdeSession> {
    const key = (credentials.apiKey ?? "").trim();
    const baseUrl = (credentials.baseUrl ?? "").trim() || DALUX_META.credentialFields[1].defaultValue!;
    if (!key) throw new Error("API key is required.");
    // Verify by hitting /users/me
    const me = await requestJson<any>(`${baseUrl}/users/me`, {
      headers: { "X-API-KEY": key },
    });
    return {
      providerId: "dalux",
      accessToken: key,
      refreshToken: baseUrl,
      user: {
        name: me?.name ?? me?.displayName ?? "Dalux user",
        email: me?.email,
      },
    };
  },

  async listProjects(session): Promise<CdeProject[]> {
    const json = await requestJson<any>(`${base(session)}/projects`, {
      headers: headers(session),
    });
    return (json?.data ?? json ?? []).map((p: any) => ({
      id: String(p.id ?? p.projectId),
      name: p.name ?? p.title ?? String(p.id),
      description: p.description,
    }));
  },

  async listFolders(session, projectId, parentId): Promise<CdeFolder[]> {
    const url = parentId
      ? `${base(session)}/projects/${projectId}/folders/${parentId}`
      : `${base(session)}/projects/${projectId}/folders`;
    const json = await requestJson<any>(url, { headers: headers(session) });
    return (json?.data ?? json ?? []).map((f: any) => ({
      id: String(f.id ?? f.folderId),
      name: f.name ?? f.title ?? String(f.id),
      parentId,
    }));
  },

  async listFiles(session, projectId, folderId): Promise<CdeFile[]> {
    const url = `${base(session)}/projects/${projectId}/folders/${folderId}/files`;
    const json = await requestJson<any>(url, { headers: headers(session) });
    return (json?.data ?? json ?? []).map((f: any) => ({
      id: String(f.id ?? f.fileId),
      name: f.name ?? f.fileName ?? String(f.id),
      size: Number(f.size ?? f.fileSize) || undefined,
      updatedAt: Date.parse(f.updated ?? f.modified ?? "") || undefined,
      folderId,
    }));
  },

  async downloadFile(session, projectId, fileId): Promise<Blob> {
    const url = `${base(session)}/projects/${projectId}/files/${fileId}/download`;
    const res = await requestRaw(url, { headers: headers(session) });
    return await res.blob();
  },

  async uploadFile(session, projectId, folderId, name, data): Promise<CdeFile> {
    const url = `${base(session)}/projects/${projectId}/folders/${folderId}/files`;
    const form = new FormData();
    form.append("file", data, name);
    const res = await requestRaw(url, {
      method: "POST",
      headers: headers(session),
      body: form,
      raw: true,
    });
    const json = await res.json();
    return {
      id: String(json?.id ?? ""),
      name,
      size: data.size,
      updatedAt: Date.now(),
      folderId,
    };
  },

  async createIssue(session, projectId, issue): Promise<{ id: string; url?: string }> {
    const url = `${base(session)}/projects/${projectId}/issues`;
    const json = await requestJson<any>(url, {
      method: "POST",
      headers: headers(session),
      body: {
        title: issue.title,
        description: issue.description,
        status: issue.status ?? "New",
        assignee: issue.assignee,
        dueDate: issue.dueDate,
      },
    });
    return { id: String(json?.id ?? ""), url: json?.url };
  },
};