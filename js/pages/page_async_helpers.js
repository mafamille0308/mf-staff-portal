import { openBlockingOverlay } from "../ui.js";

const DEFAULT_LOADING_OPTS_ = {
  busyText: "確認しています",
  petSpriteUrl: "./assets/images/loading/wag-duo-spritesheet.webp",
  petAlt: "確認しています",
};

export async function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(Object.assign({}, DEFAULT_LOADING_OPTS_, opts || {}));
  try {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return await task(blocker);
  } finally {
    blocker.close();
  }
}

export async function runWithLoading_(opts, task) {
  return runWithBlocking_(Object.assign({
    title: "データ取得中",
  }, opts || {}), task);
}
