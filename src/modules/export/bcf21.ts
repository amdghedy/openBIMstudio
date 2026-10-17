/**
 * BCF 2.1 writer.
 *
 * Produces a real BCF 2.1 archive (ZIP) with:
 *   bcf.version
 *   project.bcfp
 *   <guid>/markup.bcf
 *   <guid>/viewpoint-*.bcfv      (optional — requires camera state)
 *   <guid>/snapshot.png          (optional)
 *
 * Both clash violations and standards violations can be written to the
 * same archive, distinguished by TopicType.
 */
import JSZip from "jszip";
import type { ElementClash, ClashKind } from "../../features/clash-engine";
import { getClashState, listClashes, testNameInput, type ClashStatus } from "../../features/clash";
import { getAuthor } from "../issues/issues";

const BCF_VERSION = "2.1";

export interface BcfStandardsViolation {
  ruleId: string;
  ruleName: string;
  standard: string;
  jurisdiction: string;
  severity: "info" | "warning" | "error";
  category: string;
  elementId: number;
  elementName: string;
  elementCategory: string;
  message: string;
  actual?: string;
  required?: string;
  modelId?: string;
}

export interface BcfCameraState {
  position: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fieldOfView?: number;
  aspect?: number;
}

export interface BcfComponentRef {
  ifcGuid?: string;
  authoringToolId?: string;
  originatingSystem?: string;
}

export interface BcfTopic {
  guid: string;
  title: string;
  description?: string;
  topicType: string;
  topicStatus: string;
  priority?: string;
  assignedTo?: string;
  labels?: string[];
  createdBy: string;
  createdAt: number;
  modifiedAt?: number;
  modifiedBy?: string;
  comments?: Array<{ author: string; date: number; text: string; guid?: string }>;
  selection?: BcfComponentRef[];
  visibilityExceptions?: BcfComponentRef[];
  camera?: BcfCameraState;
  snapshotDataUrl?: string;
}

export interface BcfWriteOptions {
  projectName?: string;
  projectId?: string;
  author?: string;
  /** Include standards violations as topics. Default true. */
  includeClashes?: boolean;
  includeStandards?: boolean;
  standardsViolations?: BcfStandardsViolation[];
  /** If set, this is used as the "originating system" on components. */
  originatingSystem?: string;
  /** Optional resolver for element GlobalIds (fragments model id + express id → guid). */
  resolveGuid?: (modelId: string, localId: number) => string | undefined;
  /** Optional camera state provider for the current view. */
  getCamera?: () => BcfCameraState | undefined;
  /** Optional snapshot data URL provider. */
  getSnapshot?: () => string | undefined;
}

/* ── Utilities ─────────────────────────────────────────────────────────── */

function uid(): string {
  return (crypto as any).randomUUID?.() ??
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
}

function xmlEscape(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" } as any)[c]);
}

function isoDate(t: number): string {
  const d = new Date(t);
  // BCF requires a full local ISO-8601 with offset.
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = Math.floor(Math.abs(off) / 60);
  const om = Math.abs(off) % 60;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(oh)}:${pad(om)}`
  );
}

/* ── Topic builders ────────────────────────────────────────────────────── */

function clashTopicType(k: ClashKind): string {
  switch (k) {
    case "intersect": return "Hard Clash";
    case "touching": return "Touching";
    case "clearance": return "Clearance";
    case "duplicate": return "Duplicate";
  }
}

function clashTopicStatus(s: ClashStatus): string {
  switch (s) {
    case "new": return "Open";
    case "active": return "In Progress";
    case "reviewed": return "Resolved";
    case "approved": return "Closed";
    case "resolved": return "Closed";
  }
}

export function clashToTopic(
  c: ElementClash,
  index: number,
  opts: BcfWriteOptions,
): BcfTopic {
  const state = getClashState(c);
  const author = opts.author ?? getAuthor();
  const guid = uid();
  const createdAt = state.updatedAt || Date.now();
  const modAt = state.updatedAt || undefined;

  const selection: BcfComponentRef[] = [];
  const pushRef = (modelId: string, localId: number) => {
    const ifcGuid = opts.resolveGuid?.(modelId, localId);
    selection.push({
      ifcGuid,
      authoringToolId: String(localId),
      originatingSystem: opts.originatingSystem ?? modelId,
    });
  };
  pushRef(c.a.modelId, c.a.localId);
  pushRef(c.b.modelId, c.b.localId);

  const overlapText =
    c.kind === "intersect" ? `Overlap volume: ${(c.depthVol * 1e6).toFixed(2)} cm³`
    : c.kind === "duplicate" ? `Identical bounding box (Δ ≤ ${(c.minGap * 1000).toFixed(1)} mm)`
    : `Minimum gap: ${(c.minGap * 1000).toFixed(1)} mm`;

  const description = [
    `Clash #${index + 1} — ${c.kind.toUpperCase()}`,
    ``,
    `A: ${c.a.name} [${c.a.cat}] (${c.a.modelId} / #${c.a.localId})`,
    `B: ${c.b.name} [${c.b.cat}] (${c.b.modelId} / #${c.b.localId})`,
    ``,
    overlapText,
    `Method: ${c.method} · Precision: ${c.precision}${c.triPairs ? ` · ${c.triPairs} tri pair(s)` : ""}`,
  ].join("\n");

  const labels = ["clash", c.kind, c.method];

  return {
    guid,
    title: `[${c.kind.toUpperCase()}] ${c.a.name} × ${c.b.name}`,
    description,
    topicType: clashTopicType(c.kind),
    topicStatus: clashTopicStatus(state.status),
    priority: c.kind === "intersect" ? "High" : "Normal",
    assignedTo: state.assignee,
    labels,
    createdBy: author,
    createdAt,
    modifiedAt: modAt,
    modifiedBy: state.comments.length ? author : undefined,
    comments: state.comments.map((cm) => ({
      author: cm.author, date: cm.date, text: cm.text, guid: cm.id,
    })),
    selection,
    camera: opts.getCamera?.(),
    snapshotDataUrl: opts.getSnapshot?.(),
  };
}

export function standardsViolationToTopic(
  v: BcfStandardsViolation,
  index: number,
  opts: BcfWriteOptions,
): BcfTopic {
  const author = opts.author ?? getAuthor();
  const guid = uid();
  const createdAt = Date.now();

  const selection: BcfComponentRef[] = [];
  if (v.modelId) {
    const ifcGuid = opts.resolveGuid?.(v.modelId, v.elementId);
    selection.push({
      ifcGuid,
      authoringToolId: String(v.elementId),
      originatingSystem: opts.originatingSystem ?? v.modelId,
    });
  }

  const description = [
    `Standard: ${v.standard} (${v.jurisdiction})`,
    `Rule: ${v.ruleName} [${v.ruleId}]`,
    ``,
    v.message,
    v.actual ? `Actual:   ${v.actual}` : "",
    v.required ? `Required: ${v.required}` : "",
    ``,
    `Element: ${v.elementName} [${v.elementCategory}] #${v.elementId}`,
  ].filter(Boolean).join("\n");

  return {
    guid,
    title: `[${v.severity.toUpperCase()}] ${v.ruleName} — ${v.elementName}`,
    description,
    topicType: "Code Compliance",
    topicStatus: v.severity === "error" ? "Open" : "In Progress",
    priority: v.severity === "error" ? "High" : v.severity === "warning" ? "Normal" : "Low",
    labels: ["standards", v.standard, v.category, v.severity],
    createdBy: author,
    createdAt,
    modifiedAt: createdAt,
    modifiedBy: author,
    selection,
    camera: opts.getCamera?.(),
    snapshotDataUrl: opts.getSnapshot?.(),
  };
}

/* ── XML writers ───────────────────────────────────────────────────────── */

function writeBcfVersion(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="${BCF_VERSION}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="version.xsd"/>
`;
}

function writeProjectBcfp(projectName: string, projectGuid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ProjectExtension xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="project.xsd">
  <Project ProjectId="${xmlEscape(projectGuid)}">
    <Name>${xmlEscape(projectName)}</Name>
  </Project>
  <ExtensionSchema>extensions.xsd</ExtensionSchema>
</ProjectExtension>
`;
}

function writeExtensions(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Extensions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="extensions.xsd">
  <TopicTypes>
    <TopicType>Hard Clash</TopicType>
    <TopicType>Touching</TopicType>
    <TopicType>Clearance</TopicType>
    <TopicType>Duplicate</TopicType>
    <TopicType>Code Compliance</TopicType>
    <TopicType>Issue</TopicType>
  </TopicTypes>
  <TopicStatuses>
    <TopicStatus>Open</TopicStatus>
    <TopicStatus>In Progress</TopicStatus>
    <TopicStatus>Resolved</TopicStatus>
    <TopicStatus>Closed</TopicStatus>
  </TopicStatuses>
  <Priorities>
    <Priority>Low</Priority>
    <Priority>Normal</Priority>
    <Priority>High</Priority>
  </Priorities>
  <TopicLabels>
    <TopicLabel>clash</TopicLabel>
    <TopicLabel>intersect</TopicLabel>
    <TopicLabel>touching</TopicLabel>
    <TopicLabel>clearance</TopicLabel>
    <TopicLabel>duplicate</TopicLabel>
    <TopicLabel>standards</TopicLabel>
  </TopicLabels>
</Extensions>
`;
}

function writeMarkupBcf(t: BcfTopic, viewpointFile?: string): string {
  const comments = (t.comments ?? []).map((c) => `
    <Comment Guid="${xmlEscape(c.guid ?? uid())}">
      <Date>${isoDate(c.date)}</Date>
      <Author>${xmlEscape(c.author)}</Author>
      <Comment>${xmlEscape(c.text)}</Comment>
    </Comment>`).join("");

  const labels = (t.labels ?? []).length
    ? `<Labels>${t.labels!.map((l) => xmlEscape(l)).join(", ")}</Labels>`
    : "";

  const viewpoint = viewpointFile
    ? `<Viewpoints Guid="${xmlEscape(uid())}">${xmlEscape(viewpointFile)}</Viewpoints>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="markup.xsd">
  <Header>
    <File IfcProject="" IfcSpatialStructureElement="" IsExternal="false">
      <Filename>Open BIM Studio</Filename>
      <Date>${isoDate(t.createdAt)}</Date>
      <Reference>Open BIM Studio coordination</Reference>
    </File>
  </Header>
  <Topic Guid="${xmlEscape(t.guid)}" TopicType="${xmlEscape(t.topicType)}" TopicStatus="${xmlEscape(t.topicStatus)}">
    <Title>${xmlEscape(t.title)}</Title>
    ${t.priority ? `<Priority>${xmlEscape(t.priority)}</Priority>` : ""}
    ${labels}
    <CreationDate>${isoDate(t.createdAt)}</CreationDate>
    <CreationAuthor>${xmlEscape(t.createdBy)}</CreationAuthor>
    ${t.modifiedAt ? `<ModifiedDate>${isoDate(t.modifiedAt)}</ModifiedDate>` : ""}
    ${t.modifiedBy ? `<ModifiedAuthor>${xmlEscape(t.modifiedBy)}</ModifiedAuthor>` : ""}
    ${t.assignedTo ? `<AssignedTo>${xmlEscape(t.assignedTo)}</AssignedTo>` : ""}
    ${t.description ? `<Description>${xmlEscape(t.description)}</Description>` : ""}
    ${comments}
    ${viewpoint}
  </Topic>
</Markup>
`;
}

function writeViewpointBcfv(t: BcfTopic): string | null {
  const hasSelection = (t.selection?.length ?? 0) > 0;
  const hasCamera = !!t.camera;
  if (!hasSelection && !hasCamera) return null;

  const components = hasSelection
    ? `<Components>
    <Selection>
${t.selection!.map((c) =>
  `      <Component${c.ifcGuid ? ` IfcGuid="${xmlEscape(c.ifcGuid)}"` : ""}` +
  `${c.authoringToolId ? ` AuthoringToolId="${xmlEscape(c.authoringToolId)}"` : ""}` +
  `${c.originatingSystem ? ` OriginatingSystem="${xmlEscape(c.originatingSystem)}"` : ""}/>`
).join("\n")}
    </Selection>
    <Visibility DefaultVisibility="false">
      <Exceptions>
${t.selection!.map((c) =>
  `        <Component${c.ifcGuid ? ` IfcGuid="${xmlEscape(c.ifcGuid)}"` : ""}/>`
).join("\n")}
      </Exceptions>
    </Visibility>
    <ViewSetupHints SpacesVisible="false" SpaceBoundariesVisible="false" OpeningsVisible="false"/>
  </Components>`
    : `<Components><Visibility DefaultVisibility="true"/></Components>`;

  const camera = hasCamera
    ? `<PerspectiveCamera>
    <CameraViewPoint>
      <X>${t.camera!.position.x.toFixed(4)}</X>
      <Y>${t.camera!.position.y.toFixed(4)}</Y>
      <Z>${t.camera!.position.z.toFixed(4)}</Z>
    </CameraViewPoint>
    <CameraDirection>
      <X>${t.camera!.direction.x.toFixed(4)}</X>
      <Y>${t.camera!.direction.y.toFixed(4)}</Y>
      <Z>${t.camera!.direction.z.toFixed(4)}</Z>
    </CameraDirection>
    <CameraUpVector>
      <X>${t.camera!.up.x.toFixed(4)}</X>
      <Y>${t.camera!.up.y.toFixed(4)}</Y>
      <Z>${t.camera!.up.z.toFixed(4)}</Z>
    </CameraUpVector>
    <FieldOfView>${(t.camera!.fieldOfView ?? 60).toFixed(2)}</FieldOfView>
    <AspectRatio>${(t.camera!.aspect ?? 1.7777).toFixed(4)}</AspectRatio>
  </PerspectiveCamera>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="visinfo.xsd" Guid="${xmlEscape(uid())}">
  ${components}
  ${camera}
</VisualizationInfo>
`;
}

/* ── Data URL → Uint8Array ─────────────────────────────────────────────── */

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/* ── Public API ────────────────────────────────────────────────────────── */

export interface BcfBuildResult {
  blob: Blob;
  topicCount: number;
  filename: string;
}

export async function buildBcf21(
  topics: BcfTopic[],
  opts: BcfWriteOptions = {},
): Promise<BcfBuildResult> {
  const zip = new JSZip();
  const projectGuid = opts.projectId ?? uid();
  const projectName = opts.projectName ?? "Open BIM Studio Project";

  zip.file("bcf.version", writeBcfVersion());
  zip.file("project.bcfp", writeProjectBcfp(projectName, projectGuid));
  zip.file("extensions.xsd", writeExtensions());

  for (const t of topics) {
    const folder = zip.folder(t.guid)!;
    let viewpointFile: string | undefined;
    const bcfv = writeViewpointBcfv(t);
    if (bcfv) {
      viewpointFile = "viewpoint.bcfv";
      folder.file(viewpointFile, bcfv);
    }
    if (t.snapshotDataUrl) {
      const bytes = dataUrlToBytes(t.snapshotDataUrl);
      if (bytes) folder.file("snapshot.png", bytes);
    }
    folder.file("markup.bcf", writeMarkupBcf(t, viewpointFile));
  }

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/zip",
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    blob,
    topicCount: topics.length,
    filename: `coordination-${stamp}.bcfzip`,
  };
}

export async function downloadBcf21(
  topics: BcfTopic[],
  opts: BcfWriteOptions = {},
): Promise<void> {
  const { blob, filename } = await buildBcf21(topics, opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/* ── Convenience: export the current clash results ─────────────────────── */

export async function exportClashesBcf(
  opts: BcfWriteOptions = {},
): Promise<void> {
  const clashes = listClashes();
  if (!clashes.length) {
    alert("No clash results to export. Run a clash test first.");
    return;
  }
  const testName = testNameInput.value || "Clash Test";
  const topics = clashes.map((c, i) => clashToTopic(c, i, opts));
  await downloadBcf21(topics, { ...opts, projectName: opts.projectName ?? testName });
}

/* ── Convenience: export standards violations ──────────────────────────── */

export async function exportStandardsBcf(
  violations: BcfStandardsViolation[],
  opts: BcfWriteOptions = {},
): Promise<void> {
  if (!violations.length) {
    alert("No standards violations to export.");
    return;
  }
  const topics = violations.map((v, i) => standardsViolationToTopic(v, i, opts));
  await downloadBcf21(topics, {
    ...opts,
    projectName: opts.projectName ?? "Standards Compliance",
  });
}

/* ── Convenience: both in one file ─────────────────────────────────────── */

export async function exportCombinedBcf(
  violations: BcfStandardsViolation[] | undefined,
  opts: BcfWriteOptions = {},
): Promise<void> {
  const topics: BcfTopic[] = [];
  if (opts.includeClashes !== false) {
    listClashes().forEach((c, i) => topics.push(clashToTopic(c, i, opts)));
  }
  if (opts.includeStandards !== false && violations?.length) {
    violations.forEach((v, i) => topics.push(standardsViolationToTopic(v, i, opts)));
  }
  if (!topics.length) {
    alert("Nothing to export — run a clash test or a standards check first.");
    return;
  }
  await downloadBcf21(topics, {
    ...opts,
    projectName: opts.projectName ?? "Coordination",
  });
}