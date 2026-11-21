/**
 * Natural-language modelling — "draw a 4×6 room with a door and two windows".
 *
 * Keyless by design: the parser, the planner and the executor use only the
 * local authoring engine, so modelling from words works with no API key
 * and no server. The cloud AI chat can also drive it (tool `create_room`
 * in ai-tools.ts), but the words-to-model path itself never needs a key.
 */
export { parseRoomCommand, DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS } from "./parse";
export type { RoomRequest, OpeningRequest } from "./parse";
export { planRoom, layoutOpenings, wallLength, OPENING_MARGIN } from "./plan";
export type { RoomPlan, WallSegment, OpeningPlacement } from "./plan";
export { executeRoomPlan } from "./execute";
export type { AuthoringLike, RoomBuildResult } from "./execute";
