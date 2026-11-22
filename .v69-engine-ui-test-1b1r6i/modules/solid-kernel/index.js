"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweepProfile = exports.profileArea = exports.meshVolume = void 0;
/**
 * Solid geometry kernel — public barrel (Design spec MODULE 2.7–2.9, 2.12).
 */
var adaptive_1 = require("../adaptive");
Object.defineProperty(exports, "meshVolume", { enumerable: true, get: function () { return adaptive_1.meshVolume; } });
Object.defineProperty(exports, "profileArea", { enumerable: true, get: function () { return adaptive_1.profileArea; } });
Object.defineProperty(exports, "sweepProfile", { enumerable: true, get: function () { return adaptive_1.sweepProfile; } });
__exportStar(require("./brep"), exports);
__exportStar(require("./forms"), exports);
__exportStar(require("./csg"), exports);
__exportStar(require("./general-csg"), exports);
__exportStar(require("./shell"), exports);
__exportStar(require("./loft"), exports);
__exportStar(require("./voids"), exports);
__exportStar(require("./validate"), exports);
