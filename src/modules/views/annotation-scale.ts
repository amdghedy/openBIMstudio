/**
 * Annotation Scale Independence Engine.
 *
 * Ensures annotations (dimensions, tags, symbols, text) render at the exact
 * desired physical print size (e.g. 2.5mm text, 3mm tick mark) regardless of
 * the view scale (1:50, 1:100, 1:200, etc.).
 */

export interface AnnotationScaleConfig {
  basePrintTextHeightMm: number; // e.g. 2.5 mm on sheet
  baseTickSizeMm: number; // e.g. 2.0 mm
  baseArrowSizeMm: number; // e.g. 3.0 mm
  baseLeaderGapMm: number; // e.g. 1.5 mm
}

export const DEFAULT_ANNOTATION_CONFIG: AnnotationScaleConfig = {
  basePrintTextHeightMm: 2.5,
  baseTickSizeMm: 2.0,
  baseArrowSizeMm: 3.0,
  baseLeaderGapMm: 1.5,
};

/**
 * Parses scale string (e.g. "1:100", "1:50", "1/4\" = 1'-0\"") into scale ratio denominator.
 */
export function parseViewScaleRatio(scaleStr: string): number {
  if (!scaleStr) return 100;
  const match = scaleStr.match(/1\s*:\s*(\d+)/);
  if (match) return parseInt(match[1], 10);

  // Imperial fallback
  if (scaleStr.includes('1/4"')) return 48;
  if (scaleStr.includes('1/8"')) return 96;
  if (scaleStr.includes('1/2"')) return 24;

  return 100;
}

/**
 * Computes world-model coordinate size (meters) so an annotation prints at
 * desired target millimeters on a physical sheet.
 */
export function getModelAnnotationSize(
  targetPrintSizeMm: number,
  viewScaleStr: string
): number {
  const ratio = parseViewScaleRatio(viewScaleStr);
  // targetPrintSizeMm / 1000 * ratio
  return (targetPrintSizeMm / 1000) * ratio;
}

export function scaleDimensionGeometry(
  viewScaleStr: string,
  config: AnnotationScaleConfig = DEFAULT_ANNOTATION_CONFIG
): {
  textHeightM: number;
  tickSizeM: number;
  arrowSizeM: number;
  leaderGapM: number;
} {
  return {
    textHeightM: getModelAnnotationSize(config.basePrintTextHeightMm, viewScaleStr),
    tickSizeM: getModelAnnotationSize(config.baseTickSizeMm, viewScaleStr),
    arrowSizeM: getModelAnnotationSize(config.baseArrowSizeMm, viewScaleStr),
    leaderGapM: getModelAnnotationSize(config.baseLeaderGapMm, viewScaleStr),
  };
}
