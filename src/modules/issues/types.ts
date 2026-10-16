export type IssueStatus = "open" | "active" | "resolved" | "closed";
export type IssuePriority = "low" | "medium" | "high";

export interface ClippingPlaneState {
  /** Point on the plane, world coordinates. */
  location: [number, number, number];
  /** Unit normal, world coordinates. */
  direction: [number, number, number];
}

export interface IssueViewpoint {
  cam: [number, number, number];
  target: [number, number, number];
  projection: "perspective" | "orthographic";
  thumbnail?: string; // dataURL png
  /** Selected elements: modelId → localIds. Serialized to BCF as IfcGuids. */
  selection?: Record<string, number[]>;

  // ── BCF 3.0 additions (all optional) ─────────────────────────────────
  /** Up vector; defaults to (0,1,0) if absent. */
  up?: [number, number, number];
  /** Clipping planes active when the viewpoint was captured. */
  clippingPlanes?: ClippingPlaneState[];
  /** Hidden elements: modelId → localIds. */
  hidden?: Record<string, number[]>;
  /** Orthographic view-to-world scale (only meaningful when projection = orthographic). */
  orthoScale?: number;
}

export interface IssueComment {
  id: string;
  author: string;
  date: number;
  text: string;
  viewpoint?: IssueViewpoint;
}

export interface Issue {
  id: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: IssuePriority;
  author: string;
  createdAt: number;
  updatedAt: number;
  /** BCF "AssignedTo" field. */
  assignee?: string;
  /** BCF "DueDate". */
  dueDate?: number;
  viewpoint: IssueViewpoint;
  comments: IssueComment[];
}