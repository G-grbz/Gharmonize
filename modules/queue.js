import { getJob } from "./store.js";

const jobQueue = [];
let isRunning = false;

// Handles enqueue job state in core application logic.
export function enqueueJob(jobId, fn) {
  jobQueue.push({ jobId, fn });
  runQueue();
}

// Returns queued job state ids used for core application logic.
export function getQueuedJobIds() {
  return jobQueue.map(j => j.jobId);
}

// Removes from queue from core application logic.
export function removeFromQueue(jobId) {
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    if (jobQueue[i].jobId === jobId) {
      jobQueue.splice(i, 1);
    }
  }
}

// Runs queue for core application logic.
async function runQueue() {
  if (isRunning) return;
  isRunning = true;

  try {
    while (jobQueue.length > 0) {
      const { jobId, fn } = jobQueue.shift();
      const job = getJob(jobId);
      if (!job || job.status === "canceled" || job.canceled) {
        continue;
      }

      try {
        await fn();
      } catch (err) {
        console.error(`[queue] Job ${jobId} hata:`, err);
      }
    }
  } finally {
    isRunning = false;
  }
}
