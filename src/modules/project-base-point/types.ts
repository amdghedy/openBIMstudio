/**
 * Project base point & survey point — shared coordinate system.
 *
 * Revit's "Project Base Point" defines the internal origin used for
 * all geometry. The "Survey Point" defines the real-world coordinate
 * (GIS/ GPS) used for site coordination. Together they enable
 * federated models from different sources to align.
 */

export interface ProjectBasePoint {
  /** Easting (X) in project coordinates (m). */
  easting: number;
  /** Northing (Z) in project coordinates (m). */
  northing: number;
  /** Elevation (Y) in project coordinates (m). */
  elevation: number;
  /** Angle from project north to true north (degrees, clockwise). */
  angleToNorth: number;
}

export interface SurveyPoint {
  /** Real-world Easting (m). */
  surveyEasting: number;
  /** Real-world Northing (m). */
  surveyNorthing: number;
  /** Real-world Elevation (m). */
  surveyElevation: number;
}

let basePoint: ProjectBasePoint = { easting: 0, northing: 0, elevation: 0, angleToNorth: 0 };
let surveyPt: SurveyPoint = { surveyEasting: 0, surveyNorthing: 0, surveyElevation: 0 };

export function getProjectBasePoint(): ProjectBasePoint { return { ...basePoint }; }
export function setProjectBasePoint(p: Partial<ProjectBasePoint>): void {
  basePoint = { ...basePoint, ...p };
  console.log("[project-base-point] updated:", basePoint);
}
export function getSurveyPoint(): SurveyPoint { return { ...surveyPt }; }
export function setSurveyPoint(p: Partial<SurveyPoint>): void {
  surveyPt = { ...surveyPt, ...p };
  console.log("[survey-point] updated:", surveyPt);
}

/** Convert project coordinates → real-world (survey) coordinates. */
export function projectToSurvey(x: number, y: number, z: number): [number, number, number] {
  const angle = basePoint.angleToNorth * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = x - basePoint.easting;
  const dz = z - basePoint.northing;
  const rotX = dx * cos - dz * sin;
  const rotZ = dx * sin + dz * cos;
  return [
    surveyPt.surveyEasting + rotX,
    y - basePoint.elevation + surveyPt.surveyElevation,
    surveyPt.surveyNorthing + rotZ,
  ];
}

/** Convert real-world (survey) → project coordinates. */
export function surveyToProject(x: number, y: number, z: number): [number, number, number] {
  const angle = -basePoint.angleToNorth * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = x - surveyPt.surveyEasting;
  const dz = z - surveyPt.surveyNorthing;
  const rotX = dx * cos - dz * sin;
  const rotZ = dx * sin + dz * cos;
  return [
    basePoint.easting + rotX,
    y - surveyPt.surveyElevation + basePoint.elevation,
    basePoint.northing + rotZ,
  ];
}

let installed = false;
export function setupProjectBasePoint() {
  if (installed) return; installed = true;
  (window as any).__obsBasePoint = {
    get: getProjectBasePoint, set: setProjectBasePoint,
    getSurvey: getSurveyPoint, setSurvey: setSurveyPoint,
    toSurvey: projectToSurvey, toProject: surveyToProject,
  };
  console.log("[project-base-point] ready. Configure shared coordinates via __obsBasePoint.");
}
