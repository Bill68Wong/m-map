/**
 * 收藏模块出口（src/lib/favorites/index.ts，M Map 改版 S5）
 *
 * 统一从 `@/lib/favorites` 引入类型与工具，避免消费方记住文件分布。
 */
export * from "./types";
export * from "./storage";
export { SEED_VERSION, buildDefaultComboSeeds, type SeedPlaceCoord } from "./presets";
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
export {
  /** ★ v2：组合 → 组合下方案（两级模型，v2.3.0） */
  addCombo,
  removeCombo,
  updateCombo,
  togglePinCombo,
  touchCombo,
  addPlanToCombo,
  removePlanFromCombo,
  updateComboPlan,
  makeCombo,
  makeComboPlan,
  seedDefaultCombos,
  subscribeCombos,
  type UseCombos,
} from "./useCombos";
