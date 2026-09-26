/**
 * 收藏模块出口（src/lib/favorites/index.ts，M Map 改版 S5）
 *
 * 统一从 `@/lib/favorites` 引入类型与工具，避免消费方记住文件分布。
 */
export * from "./types";
export * from "./storage";
/* ★ v3.3.0（ADR-104）：**系统预置组合清退** ⇒ 不再出口种子构造器（`presets` / `route-presets` 已退役不用）。 */
export {
  addFavorite,
  removeFavorite,
  updateFavorite,
  togglePinFavorite,
  touchFavorite,
  subscribeFavorites,
  makePlaceFavorite,
  makePlanFavorite,
  type AddResult,
} from "./useFavorites";
/**
 * ★ v3.3.0（ADR-104）：收藏 v3 出口 —— **两实体**（组合 / 地点）。
 * 方案层（`addPlanToCombo` / `updateComboPlan` / `seedDefaultCombos` / `makeComboPlan`）已退役删除。
 */
export {
  /** 组合（起终点对） */
  addCombo,
  removeCombo,
  updateCombo,
  togglePinCombo,
  touchCombo,
  /** 地点（单点） */
  addPlace,
  removePlace,
  updatePlace,
  togglePinPlace,
  touchPlace,
  /** 同步判定（收藏按钮/入口双态用） */
  isComboSaved,
  isPlaceSaved,
  /** 构造器与键 */
  makeComboV3,
  makePlaceV3,
  comboV3Key,
  placeV3Key,
  subscribeCombos,
  useCombos,
  type UseCombos,
  type ComboV3,
  type PlaceV3,
} from "./useCombos";
export {
  readV3,
  writeV3,
  migrateToV3,
  hasBackupKey,
  emptyV3,
  FAVORITES_KEY_V3,
  FAVORITES_BACKUP_KEY,
  COMBO_V3_CAP,
  PLACE_V3_CAP,
  type FavoritesFileV3,
  type ReadV3Result,
} from "./v3";
