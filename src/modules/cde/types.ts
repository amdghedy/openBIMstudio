/**
 * Common Data Environment (CDE) provider contract.
 */

export type CdeProviderId =
  | "acc"
  | "autodesk"
  | "dalux"
  | "sharepoint"
  | "onedrive"
  | "googledrive"
  | "dropbox"
  | "webdav"
  | "bimplus"
  | "a360"
  | "box"
  | "custom";

export type CdeCredentials = Record<string, string>;

export interface CdeProject {
  id: string;
  name: string;
  description?: string;
  region?: string;
  createdAt?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface CdeFolder {
  id: string;
  name: string;
  parentId: string | null;
  path?: string;
  fileCount?: number;
  folderCount?: number;
  updatedAt?: number;
}

export interface CdeFile {
  id: string;
  name: string;
  version?: string;
  size?: number;
  mimeType?: string;
  updatedAt?: number;
  createdAt?: number;
  parentId?: string | null;
  folderId?: string;
  downloadUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CdeIssue {
  id: string;
  title: string;
  description?: string;
  status?: "open" | "closed" | "in-progress" | string;
  priority?: "low" | "medium" | "high" | "critical" | string;
  assignee?: string;
  dueDate?: number | string;
  url?: string;
  createdAt?: number;
  updatedAt?: number;
  extra?: Record<string, unknown>;
}

export interface CdeSession {
  providerId: CdeProviderId;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  user?: { name: string; email?: string };
  extra?: Record<string, unknown>;
}

export interface CdeCredentialField {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required: boolean;
  placeholder?: string;
  hint?: string;
  defaultValue?: string;
}

export interface CdeProviderMeta {
  id: CdeProviderId;
  label: string;
  description: string;
  icon?: string;
  pushEnabled: boolean;
  issuesEnabled: boolean;
  credentialFields: CdeCredentialField[];
}

export interface CdeProvider {
  id?: CdeProviderId;
  meta?: CdeProviderMeta;
  credentialFields?: CdeCredentialField[];

  authenticate(
    credentials: CdeCredentials,
    existing?: CdeSession,
  ): Promise<CdeSession>;

  listProjects(session: CdeSession): Promise<CdeProject[]>;

  listFolders(
    session: CdeSession,
    projectId: string,
    parentId?: string | null,
  ): Promise<CdeFolder[]>;

  listFiles(
    session: CdeSession,
    projectId: string,
    folderId?: string,
  ): Promise<CdeFile[]>;

  downloadFile(
    session: CdeSession,
    projectId: string,
    fileId: string,
  ): Promise<Blob>;

  uploadFile?(
    session: CdeSession,
    projectId: string,
    folderId: string,
    filename: string,
    body: Blob,
  ): Promise<CdeFile>;

  listIssues?(session: CdeSession, projectId: string): Promise<CdeIssue[]>;

  createIssue?(
    session: CdeSession,
    projectId: string,
    issue: Omit<CdeIssue, "id"> | CdeIssue,
  ): Promise<CdeIssue | { id: string; url?: string }>;
}

export interface CdeStoredConfig {
  providerId: CdeProviderId;
  credentials: CdeCredentials;
  session: CdeSession | null;
  updatedAt?: number;
}