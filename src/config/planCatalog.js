const flowPlansCatalog = require("../../shared/flow-plans.json");

const DEFAULT_PLAN_CODE = "pro";
const PLAN_ORDER = ["basic", "pro", "ultra", "master"];

function isPlanCode(value) {
  return PLAN_ORDER.includes(value);
}

function normalizePlanCode(value, fallback = DEFAULT_PLAN_CODE) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return isPlanCode(normalized) ? normalized : fallback;
}

function resolvePlanDefinition(value, fallback = DEFAULT_PLAN_CODE) {
  return flowPlansCatalog[normalizePlanCode(value, fallback)];
}

function resolvePlanLimitValue(value) {
  return Number.isFinite(value) ? value : 0;
}

module.exports = {
  DEFAULT_PLAN_CODE,
  PLAN_ORDER,
  isPlanCode,
  normalizePlanCode,
  resolvePlanDefinition,
  resolvePlanLimitValue,
};
