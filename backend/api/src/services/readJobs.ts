/**
 * Long statement reads run in the background. The upload answers at once with a job id and the page
 * polls for progress, so no proxy or browser has to hold one request open for minutes.
 *
 * Jobs live in this server's memory only: nothing is written to the database or disk, and a finished
 * result is dropped as soon as it has been delivered. A restart or a second server instance loses the
 * job, which the page reports as "upload again".
 */
import { randomUUID } from "node:crypto";

export interface JobOutcome {
  status: number;
  body: unknown;
}

export interface JobOwner {
  companyId: number;
  userId: number | null;
}

export interface ReadJob {
  id: string;
  owner: JobOwner;
  createdAt: number;
  state: "working" | "done";
  percent: number;
  step: string;
  outcome?: JobOutcome;
  settled: Promise<JobOutcome>;
}

const KEEP_MS = 20 * 60_000;
const jobs = new Map<string, ReadJob>();

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) if (now - job.createdAt > KEEP_MS) jobs.delete(id);
}

export function startReadJob(
  owner: JobOwner,
  work: (report: (percent: number, step: string) => void) => Promise<JobOutcome>,
): ReadJob {
  sweep();
  const job = { id: randomUUID(), owner, createdAt: Date.now(), state: "working", percent: 3, step: "Reading your statement" } as ReadJob;
  job.settled = work((percent, step) => {
    // Progress only moves forward, even when page groups finish out of order.
    job.percent = Math.max(job.percent, Math.min(99, Math.round(percent)));
    job.step = step;
  })
    .catch((): JobOutcome => ({ status: 500, body: { ok: false, message: "This statement could not be read. Please try again." } }))
    .then(outcome => {
      job.outcome = outcome;
      job.state = "done";
      job.percent = 100;
      return outcome;
    });
  jobs.set(job.id, job);
  return job;
}

/** The finished outcome if the job completes within `ms`, otherwise null. */
export function finishedWithin(job: ReadJob, ms: number): Promise<JobOutcome | null> {
  return Promise.race([job.settled, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))]);
}

/** A job is visible only to the company and user that started it. */
export function findReadJob(id: string, owner: JobOwner): ReadJob | null {
  sweep();
  const job = jobs.get(id);
  if (!job || job.owner.companyId !== owner.companyId || job.owner.userId !== owner.userId) return null;
  return job;
}

export function releaseReadJob(id: string) {
  jobs.delete(id);
}

/** Test helper. */
export function clearReadJobs() {
  jobs.clear();
}
