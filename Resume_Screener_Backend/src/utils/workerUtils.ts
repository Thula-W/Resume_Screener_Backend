import { Worker } from "bullmq";
import { redisConnection } from "./queue";
import { processResume } from "./resumeHelpers";
import { processResumeEmbeddings, processJobEmbedding } from "./embeddingHelpers";

let resumeWorker: Worker;
let resumeEmbeddingsWorker: Worker;
let jobEmbeddingsWorker: Worker;

export const startResumeWorker = async () => {
  resumeWorker = new Worker(
    "resume-queue",
    async (job) => {
      const { resumeId, constraints } = job.data;

      console.log(`Processing resume ${resumeId}`);

      await processResume(resumeId, constraints);
    },
    {
      connection: redisConnection,
      concurrency: 3, // start small
    }
  );

  resumeWorker.on("completed", (job) => {
    console.log(`✓ Completed ${job.data.resumeId}`);
  });

  resumeWorker.on("failed", (job, err) => {
    console.error(`✗ Failed ${job?.data.resumeId}:`, err.message);
  });
};

export const startResumeEmbeddingsWorker = async () => {
  resumeEmbeddingsWorker = new Worker(
    "resume-embeddings-queue",
    async (job) => {
      const data = job.data;

      console.log(`Processing resume embeddings ${data.resumeId}`);

      await processResumeEmbeddings(data);
    },
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  resumeEmbeddingsWorker.on("completed", (job) => {
    console.log(`✓ Resume embeddings completed ${job.data.resumeId}`);
  });

  resumeEmbeddingsWorker.on("failed", (job, err) => {
    console.error(`✗ Resume embeddings failed ${job?.data.resumeId}:`, err.message);
  });
};

export const startJobEmbeddingsWorker = async () => {
  jobEmbeddingsWorker = new Worker(
    "job-embeddings-queue",
    async (job) => {
      const data = job.data;
      console.log(`Processing job embedding ${data.jobId}`);

      await processJobEmbedding(data);
    },
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  jobEmbeddingsWorker.on("completed", (job) => {
    console.log(`✓ Job embedding completed ${job.data.jobId}`);
  });

  jobEmbeddingsWorker.on("failed", (job, err) => {
    console.error(`✗ Job embedding failed ${job?.data.jobId}:`, err.message);
  });
};