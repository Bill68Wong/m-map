/**
 * 收藏模块出口（src/lib/favorites/index.ts，M Map 改版 S5）
 *
 * 统一从 `@/lib/favorites` 引入类型与工具，避免消费方记住文件分布。
 */
export * from "./types";
export * from "./storage";
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
