import type { CdeProviderMeta } from "../types";

export const accMeta: CdeProviderMeta = {
  id: "acc",
  label: "Autodesk Construction Cloud",
  description: "Autodesk Docs / BIM 360 / ACC — browse hubs, projects and issues.",
  icon: "🏗️",
  pushEnabled: true,
  issuesEnabled: true,
  credentialFields: [
    { key: "clientId", label: "Client ID", type: "text", required: true,
      hint: "From the APS (Forge) app console." },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    { key: "hubId", label: "Hub ID", type: "text", required: false,
      placeholder: "Optional — leave blank to browse all hubs." },
  ],
};

export const daluxMeta: CdeProviderMeta = {
  id: "dalux",
  label: "Dalux",
  description: "Dalux Box / Field — browse projects and issues.",
  icon: "🟦",
  pushEnabled: true,
  issuesEnabled: true,
  credentialFields: [
    { key: "apiKey", label: "API key", type: "password", required: true },
    { key: "region", label: "Region", type: "text", required: false,
      placeholder: "eu / us (default: eu)" },
  ],
};

export const sharepointMeta: CdeProviderMeta = {
  id: "sharepoint",
  label: "SharePoint",
  description: "Microsoft 365 SharePoint document library.",
  icon: "📁",
  pushEnabled: true,
  issuesEnabled: false,
  credentialFields: [
    { key: "tenant", label: "Tenant", type: "text", required: true },
    { key: "clientId", label: "Client ID", type: "text", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    { key: "siteUrl", label: "Site URL", type: "url", required: true,
      placeholder: "https://contoso.sharepoint.com/sites/MySite" },
  ],
};