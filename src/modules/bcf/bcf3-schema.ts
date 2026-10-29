/**
 * BCF 3.0 Schema and Serialization (buildingSMART BCF-XML v3.0).
 *
 * Upgrades BCF 2.1 to 3.0 with:
 * - Document references
 * - Comment reply-to threading
 * - Stage and due date tracking
 * - Related topics linkage
 */

import JSZip from "jszip";

export interface BCFDocumentReference {
  guid: string;
  documentGuid?: string;
  url?: string;
  description: string;
}

export interface BCF3Comment {
  guid: string;
  date: string;
  author: string;
  comment: string;
  viewpointGuid?: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
  replyToCommentGuid?: string; // BCF 3.0 threading
}

export interface BCFViewpointCamera {
  position: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  aspectRatio?: number;
  fieldOfView?: number;
}

export interface BCF3Topic {
  guid: string;
  serverAssignedId?: string;
  topicType: string;
  topicStatus: string;
  referenceLinks: string[];
  title: string;
  labels: string[];
  creationDate: string;
  creationAuthor: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
  dueDate?: string;
  assignedTo?: string;
  stage?: string;
  priority?: "low" | "normal" | "high" | "critical";
  description?: string;
  documentReferences: BCFDocumentReference[];
  relatedTopics: string[]; // GUIDs of related topics
  comments: BCF3Comment[];
  viewpoint?: BCFViewpointCamera;
}

export function createBCF3Topic(title: string, author: string = "User"): BCF3Topic {
  return {
    guid: `topic-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    title,
    topicType: "Clash",
    topicStatus: "Open",
    creationDate: new Date().toISOString(),
    creationAuthor: author,
    referenceLinks: [],
    labels: [],
    documentReferences: [],
    relatedTopics: [],
    comments: [],
  };
}

export function migrateBCF21ToBCF3(legacyTopic: any): BCF3Topic {
  return {
    guid: legacyTopic.guid || `bcf3-${Date.now()}`,
    title: legacyTopic.title || "Migrated Topic",
    topicType: legacyTopic.topicType || "Issue",
    topicStatus: legacyTopic.topicStatus || "Open",
    creationDate: legacyTopic.creationDate || new Date().toISOString(),
    creationAuthor: legacyTopic.createdBy || legacyTopic.creationAuthor || "Author",
    priority: legacyTopic.priority || "normal",
    assignedTo: legacyTopic.assignedTo || "",
    description: legacyTopic.description || "",
    referenceLinks: [],
    labels: legacyTopic.labels || [],
    documentReferences: [],
    relatedTopics: [],
    comments: (legacyTopic.comments || []).map((c: any) => ({
      guid: c.guid || `com-${Math.random()}`,
      date: c.date || new Date().toISOString(),
      author: c.author || "User",
      comment: c.comment || "",
    })),
  };
}

export async function exportBCF3Zip(topics: BCF3Topic[]): Promise<Blob> {
  const zip = new JSZip();

  // BCF 3.0 Version file
  zip.file(
    "bcf.version",
    `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="3.0" />`
  );

  for (const topic of topics) {
    const folder = zip.folder(topic.guid);
    if (!folder) continue;

    // markup.bcf xml
    const markupXml = `<?xml version="1.0" encoding="UTF-8"?>
<Topic Guid="${topic.guid}" TopicType="${topic.topicType}" TopicStatus="${topic.topicStatus}">
  <Title>${escapeXml(topic.title)}</Title>
  <Priority>${topic.priority || "normal"}</Priority>
  <CreationDate>${topic.creationDate}</CreationDate>
  <CreationAuthor>${escapeXml(topic.creationAuthor)}</CreationAuthor>
  ${topic.dueDate ? `<DueDate>${topic.dueDate}</DueDate>` : ""}
  ${topic.assignedTo ? `<AssignedTo>${escapeXml(topic.assignedTo)}</AssignedTo>` : ""}
  ${topic.stage ? `<Stage>${escapeXml(topic.stage)}</Stage>` : ""}
  ${topic.description ? `<Description>${escapeXml(topic.description)}</Description>` : ""}
  <Labels>
    ${topic.labels.map((l) => `<Label>${escapeXml(l)}</Label>`).join("\n    ")}
  </Labels>
  <DocumentReferences>
    ${topic.documentReferences
      .map(
        (d) =>
          `<DocumentReference Guid="${d.guid}" ${d.url ? `Url="${escapeXml(d.url)}"` : ""}>${escapeXml(
            d.description
          )}</DocumentReference>`
      )
      .join("\n    ")}
  </DocumentReferences>
  <RelatedTopics>
    ${topic.relatedTopics.map((g) => `<RelatedTopic Guid="${g}" />`).join("\n    ")}
  </RelatedTopics>
  <Comments>
    ${topic.comments
      .map(
        (c) => `
    <Comment Guid="${c.guid}">
      <Date>${c.date}</Date>
      <Author>${escapeXml(c.author)}</Author>
      <Comment>${escapeXml(c.comment)}</Comment>
      ${c.replyToCommentGuid ? `<ReplyToComment Guid="${c.replyToCommentGuid}" />` : ""}
    </Comment>`
      )
      .join("")}
  </Comments>
</Topic>`;

    folder.file("markup.bcf", markupXml);
  }

  return await zip.generateAsync({ type: "blob" });
}

function escapeXml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
