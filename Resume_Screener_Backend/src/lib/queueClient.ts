// src/lib/queueClient.ts

import { JobData } from "../types";

const WORKER_INTERNAL_URL = process.env.WORKER_INTERNAL_URL!;
// e.g. https://my-backend-worker.your-subdomain.workers.dev

export async function enqueueToExtractQueue(
  messages: { resumeId: string; jobId: string }[]
): Promise<void> {
  const res = await fetch(`${WORKER_INTERNAL_URL}/internal/enqueue-extract`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'x-internal': '1' },
    body:    JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`Enqueue failed: ${res.status}`);
}

export async function enqueueRerankChunks(
  chunks: { jobId: string; resumeIds: string[]; anchorIds:   string[]; chunkIndex:  number; totalChunks: number; jobData: JobData; }[]
): Promise<void> {
  const res = await fetch(`${WORKER_INTERNAL_URL}/internal/enqueue-rerank-chunks`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'x-internal': '1' },
    body:    JSON.stringify({ chunks }),
  });
  if (!res.ok) throw new Error(`Rerank chunk enqueue failed: ${res.status}`);
}