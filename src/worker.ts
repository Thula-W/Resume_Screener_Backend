import "dotenv/config";
import { startResumeWorker } from "./utils/workerUtils.ts";

const start = async () => {
  try {
    await startResumeWorker();
    console.log("✓ Resume worker started");
  } catch (error) {
    console.error("Worker failed:", error);
    process.exit(1);
  }
};

start();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));