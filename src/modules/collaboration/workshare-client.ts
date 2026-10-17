const API_BASE = "http://localhost:4000/api";

export interface WorkshareProject {
  id: string;
  name?: string;
  data?: any;
  updatedAt?: string;
}

export const workshareClient = {
  baseUrl: API_BASE,

  async syncProject(project: WorkshareProject): Promise<boolean> {
    if (!project?.id) return false;
    try {
      const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      return res.ok;
    } catch { return false; }
  },

  async pullProject(id: string): Promise<WorkshareProject | null> {
    if (!id) return null;
    try {
      const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      return (await res.json()) as WorkshareProject;
    } catch { return null; }
  },
};