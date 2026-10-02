export type Plan = "free" | "pro";
export type PlanLimits = { maxDocuments: number; maxFileBytes: number; maxPages: number; questionsPerDay: number };
export type LimitResult = { ok: true } | { ok: false; reason: string };

const MB = 1024 * 1024;

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxDocuments: 3, maxFileBytes: 5 * MB, maxPages: 50, questionsPerDay: 20 },
  pro: { maxDocuments: 50, maxFileBytes: 20 * MB, maxPages: 300, questionsPerDay: 500 },
};

const planName = (plan: Plan) => (plan === "free" ? "Free" : "Pro");

export function checkUpload(plan: Plan, input: { documentCount: number; fileBytes: number }): LimitResult {
  const limits = PLAN_LIMITS[plan];
  if (input.documentCount >= limits.maxDocuments) {
    return { ok: false, reason: `The ${planName(plan)} plan allows up to ${limits.maxDocuments} documents. Delete one to upload another.` };
  }
  if (input.fileBytes > limits.maxFileBytes) {
    return { ok: false, reason: `Files on the ${planName(plan)} plan can be up to ${limits.maxFileBytes / MB} MB.` };
  }
  return { ok: true };
}

export function checkPages(plan: Plan, pages: number): LimitResult {
  const max = PLAN_LIMITS[plan].maxPages;
  return pages > max ? { ok: false, reason: `This PDF has ${pages} pages; the ${planName(plan)} plan allows up to ${max}.` } : { ok: true };
}

export function checkQuestion(plan: Plan, questionsToday: number): LimitResult {
  const max = PLAN_LIMITS[plan].questionsPerDay;
  return questionsToday >= max ? { ok: false, reason: `You've used all ${max} questions for today. Try again tomorrow.` } : { ok: true };
}
