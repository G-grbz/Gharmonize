import { getJob } from "./store.js";

const jobQueue = [];
let isRunning = false;

export function enqueueJob(jobId, fn) {
  jobQueue.push({ jobId, fn });
  runQueue();
}

export function getQueuedJobIds() {
  return jobQueue.map(j => j.jobId);
}

export function removeFromQueue(jobId) {
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    if (jobQueue[i].jobId === jobId) {
      jobQueue.splice(i, 1);
    }
  }
}

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
