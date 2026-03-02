import { Worker } from "bullmq";
import { redisConnection } from "./queue.ts";
import { processResume } from "./resumeHelpers.ts";

let worker: Worker;

export const startResumeWorker = async () => {
  worker = new Worker(
    "resume-queue",
    async (job) => {
      const { resumeId } = job.data;

      console.log(`Processing resume ${resumeId}`);

      await processResume(resumeId);
    },
    {
      connection: redisConnection,
      concurrency: 3, // start small
    }
  );

  worker.on("completed", (job) => {
    console.log(`✓ Completed ${job.data.resumeId}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`✗ Failed ${job?.data.resumeId}:`, err.message);
  });
};