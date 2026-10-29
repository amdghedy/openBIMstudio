/**
 * Spatial Clash Clustering Engine (DBSCAN).
 *
 * Clusters hundreds or thousands of geometric clashes into distinct, actionable
 * physical locations (e.g. "Level 2 Corridor Duct Penetration Group").
 */

import type { BCF3Topic } from "./bcf3-schema";

export interface SpatialClashItem {
  id: string;
  point: { x: number; y: number; z: number };
  categoryA: string;
  categoryB: string;
  elementIdA: string | number;
  elementIdB: string | number;
  severity: "critical" | "warning" | "info";
}

export interface ClashCluster {
  id: string;
  title: string;
  centroid: { x: number; y: number; z: number };
  radiusM: number;
  clashes: SpatialClashItem[];
  primaryDiscipline: string;
  severity: "critical" | "warning" | "info";
}

export function clusterClashes(
  clashes: SpatialClashItem[],
  epsilonM: number = 2.5, // 2.5m proximity radius
  minPoints: number = 1
): ClashCluster[] {
  const visited = new Set<string>();
  const clusters: ClashCluster[] = [];

  function dist(p1: { x: number; y: number; z: number }, p2: { x: number; y: number; z: number }) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2) + Math.pow(p1.z - p2.z, 2));
  }

  function regionQuery(item: SpatialClashItem): SpatialClashItem[] {
    return clashes.filter((other) => dist(item.point, other.point) <= epsilonM);
  }

  for (const c of clashes) {
    if (visited.has(c.id)) continue;
    visited.add(c.id);

    const neighbors = regionQuery(c);
    const clusterItems: SpatialClashItem[] = [c];

    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];
      if (!visited.has(neighbor.id)) {
        visited.add(neighbor.id);
        const subNeighbors = regionQuery(neighbor);
        if (subNeighbors.length >= minPoints) {
          neighbors.push(...subNeighbors.filter((sn) => !neighbors.some((n) => n.id === sn.id)));
        }
      }
      if (!clusterItems.some((ci) => ci.id === neighbor.id)) {
        clusterItems.push(neighbor);
      }
    }

    // Compute cluster centroid & radius
    let sumX = 0, sumY = 0, sumZ = 0;
    let maxDist = 0;
    for (const item of clusterItems) {
      sumX += item.point.x;
      sumY += item.point.y;
      sumZ += item.point.z;
    }
    const centroid = {
      x: Math.round((sumX / clusterItems.length) * 100) / 100,
      y: Math.round((sumY / clusterItems.length) * 100) / 100,
      z: Math.round((sumZ / clusterItems.length) * 100) / 100,
    };

    for (const item of clusterItems) {
      maxDist = Math.max(maxDist, dist(centroid, item.point));
    }

    const hasCritical = clusterItems.some((i) => i.severity === "critical");
    const hasWarning = clusterItems.some((i) => i.severity === "warning");
    const clusterSeverity = hasCritical ? "critical" : hasWarning ? "warning" : "info";

    // Auto title based on categories
    const cats = Array.from(new Set(clusterItems.map((ci) => `${ci.categoryA} vs ${ci.categoryB}`)));
    const title = `${cats[0] || "Collision Group"} (${clusterItems.length} clashes) near (${centroid.x}, ${centroid.y}, ${centroid.z})`;

    clusters.push({
      id: `cluster-${clusters.length + 1}`,
      title,
      centroid,
      radiusM: Math.round(maxDist * 100) / 100,
      clashes: clusterItems,
      primaryDiscipline: cats[0] || "General",
      severity: clusterSeverity,
    });
  }

  return clusters;
}

export function clashClusterToBCFTopic(cluster: ClashCluster, author: string = "Clash Detector"): BCF3Topic {
  return {
    guid: `cluster-${Date.now()}-${cluster.id}`,
    title: cluster.title,
    topicType: "Clash",
    topicStatus: "Open",
    priority: cluster.severity === "critical" ? "critical" : "normal",
    creationDate: new Date().toISOString(),
    creationAuthor: author,
    description: `Automated clash cluster containing ${cluster.clashes.length} interference points within a ${cluster.radiusM}m radius.`,
    labels: ["Clash-Cluster", cluster.primaryDiscipline],
    referenceLinks: [],
    documentReferences: [],
    relatedTopics: [],
    comments: [
      {
        guid: `com-${Date.now()}`,
        date: new Date().toISOString(),
        author,
        comment: `Cluster centered at (${cluster.centroid.x}, ${cluster.centroid.y}, ${cluster.centroid.z}). Coordinated resolution recommended before fabrication.`,
      },
    ],
  };
}
