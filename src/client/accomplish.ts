export interface AccomplishGoalPrefill {
  task: string;
  description: string;
  outcome: string;
}

const LIMITS = {
  task: 160,
  description: 4_000,
  outcome: 500,
} as const;
export function parseAccomplishGoalPrefill(search: string): AccomplishGoalPrefill | null {
  const parameters = new URLSearchParams(search.replace(/^[?#]/, ""));
  if (parameters.get("accomplish") !== "1") return null;
  const task = parameters.get("task")?.trim() ?? "";
  const description = parameters.get("description")?.trim() ?? "";
  const outcome = parameters.get("outcome")?.trim() ?? "";
  if (
    !task ||
    task.length > LIMITS.task ||
    !description ||
    description.length > LIMITS.description ||
    !outcome ||
    outcome.length > LIMITS.outcome
  ) {
    return null;
  }
  return { task, description, outcome };
}

export function consumeAccomplishGoalPrefill(): AccomplishGoalPrefill | null {
  if (typeof window === "undefined") return null;
  const prefill = parseAccomplishGoalPrefill(window.location.hash);
  if (!prefill) return null;
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
  return prefill;
}
