export const FLOOR_BOARD_MODES = ["lead", "manager", "owner", "tv"] as const;

export type FloorBoardMode = (typeof FLOOR_BOARD_MODES)[number];

export function parseFloorBoardMode(raw: string | undefined): FloorBoardMode {
  if (raw && (FLOOR_BOARD_MODES as readonly string[]).includes(raw)) {
    return raw as FloorBoardMode;
  }
  return "lead";
}
