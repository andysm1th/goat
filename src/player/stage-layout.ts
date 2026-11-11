// Where the 16:9 art sits inside a stage of any shape. Pure geometry.

/** The animal's bounding box over the whole cycle, as fractions of the art. */
export type Focus = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Mean horizontal centre of the animal; the box bounds its full reach. */
  centre?: number;
};

/**
 * `fill` keeps the goat a sensible size in the centre and lets the background
 * extend to every edge. `contain` shows the whole 16:9 frame, letterboxed.
 */
export type StageFit = "fill" | "contain";

export type StageLayout = {
  /** Stage pixels per layout unit of the art. */
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Stage pixels not covered by the art on each side; zero when it overflows. */
  gapLeft: number;
  gapRight: number;
  gapTop: number;
  gapBottom: number;
};

export const DEFAULT_FOCUS: Focus = {
  left: 0.144,
  top: 0.094,
  right: 0.719,
  bottom: 0.965,
  centre: 0.45,
};

// The goat may span at most this much of the stage before the art stops
// growing with it. Height is looser: the box already includes the ground.
const MAX_FOCUS_WIDTH = 0.9,
  MAX_FOCUS_HEIGHT = 0.94;

export function layoutStage(
  stageWidth: number,
  stageHeight: number,
  artWidth: number,
  artHeight: number,
  focus: Focus = DEFAULT_FOCUS,
  fit: StageFit = "fill",
): StageLayout {
  if (!(stageWidth > 0 && stageHeight > 0 && artWidth > 0 && artHeight > 0)) {
    return {
      scale: 0,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      gapLeft: 0,
      gapRight: 0,
      gapTop: 0,
      gapBottom: 0,
    };
  }
  if (fit === "contain") {
    const scale = Math.min(stageWidth / artWidth, stageHeight / artHeight);
    const width = artWidth * scale,
      height = artHeight * scale;
    return {
      scale,
      width,
      height,
      left: (stageWidth - width) / 2,
      top: (stageHeight - height) / 2,
      gapLeft: 0,
      gapRight: 0,
      gapTop: 0,
      gapBottom: 0,
    };
  }
  const cover = Math.max(stageWidth / artWidth, stageHeight / artHeight);
  const focusWidth = (focus.right - focus.left) * artWidth,
    focusHeight = (focus.bottom - focus.top) * artHeight;
  const scale = Math.min(
    cover,
    (stageWidth * MAX_FOCUS_WIDTH) / focusWidth,
    (stageHeight * MAX_FOCUS_HEIGHT) / focusHeight,
  );
  const width = artWidth * scale,
    height = artHeight * scale;
  // Horizontally the goat is always centred; the background mirrors outward to
  // cover whatever that uncovers. Vertically the art stays edge to edge while
  // it is tall enough, so the ground never floats above the bottom edge.
  const left =
    stageWidth / 2 - (focus.centre ?? (focus.left + focus.right) / 2) * width;
  const centred = stageHeight / 2 - ((focus.top + focus.bottom) / 2) * height;
  const top =
    height >= stageHeight
      ? Math.min(0, Math.max(stageHeight - height, centred))
      : centred;
  return {
    scale,
    left,
    top,
    width,
    height,
    gapLeft: Math.max(0, left),
    gapRight: Math.max(0, stageWidth - left - width),
    gapTop: Math.max(0, top),
    gapBottom: Math.max(0, stageHeight - top - height),
  };
}
