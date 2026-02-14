/**
 * 通用辅助函数
 * 避免在多个文件中重复定义相同的工具函数
 */

/**
 * 将任意输入安全转换为数字，失败则返回 fallback
 * @param {*} value - 要转换的值
 * @param {number} fallback - 转换失败时的默认值
 * @returns {number}
 */
function toNumberSafe(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  toNumberSafe
};
