import { Queue } from "bullmq";
import IORedis from "ioredis";

export const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

export const resumeQueue = new Queue("resume-queue", {
  connection: redisConnection,
});

export const closeQueue = async () => {
  await resumeQueue.close();
  await redisConnection.quit();
};