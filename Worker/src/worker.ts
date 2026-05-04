import { Container, getContainer } from '@cloudflare/containers';
import { DurableObject } from 'cloudflare:workers';

// ─── Types ──────────────────────────────────────────────────────────────────
interface Env {
  MY_BACKEND:    DurableObjectNamespace<MyBackendContainer>;
  JOB_TRACKER:   DurableObjectNamespace<JobProgressTracker>;
  RERANK_TRACKER: DurableObjectNamespace<RerankProgressTracker>;
  EXTRACT_QUEUE: Queue;
  RERANK_QUEUE:  Queue;   // routes to rerank-job consumer
  RERANK_CHUNKS: Queue;   // routes to rerank-chunks consumer
  RERANK_FINALIZE:   Queue;
}

interface JobData {
  title: string;
  overview: string | null;
  bioText: string | null;
  skillsText: string | null;
  experienceText: string | null;
}

interface ExtractMessage   { resumeId: string; jobId: string; }
interface BatchItemResult  { resumeId: string; jobId: string; outcome: 'processed' | 'failed'; retriable?: boolean; }
interface RerankChunkMessage {
  jobId:       string;
  resumeIds:   string[];  // regular chunk IDs
  anchorIds:   string[];  // anchor IDs — always included alongside regular
  chunkIndex:  number;
  totalChunks: number;
  jobData:     JobData;
}
type QueueMessage = ExtractMessage | RerankChunkMessage | { jobId: string };


export class MyBackendContainer extends Container {
  defaultPort = 8080;
  sleepAfter  = '10m';
  enableInternet = true;
}

async function fetchWithRetry(
  env: Env,
  slot: string,
  url: string,
  method: string,
  headers?: any,
  reqbody?: any,
  maxAttempts = 4,
  baseDelayMs = 1500
): Promise<Response> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const container = getContainer(env.MY_BACKEND, slot);
      const res = await container.fetch(
        new Request(url, {
          method: method,
          headers: headers,
          body: JSON.stringify(reqbody), // re-serialized fresh each time
        })
      );

      if (res.ok) return res;

      const body = await res.text();

      // Container not ready yet — wait and retry
      const isContainerNotReady =
        res.status === 503 ||
        body.includes('no container instance') ||
        body.includes('try again later');

      if (isContainerNotReady) {
        const delay = baseDelayMs * 2 ** (attempt - 1); // 1500, 3000, 6000, 12000ms
        console.warn(`[extract] slot=${slot} not ready (attempt ${attempt}/${maxAttempts}), waiting ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        lastErr = new Error(`Container not ready: ${body}`);
        continue;
      }

      // Non-retryable error — return as-is
      return new Response(body, { status: res.status });

    } catch (err) {
      const msg = String(err);
      const isContainerNotReady =
        msg.includes('no container instance') ||
        msg.includes('try again later');

      if (isContainerNotReady) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.warn(`[extract] slot=${slot} threw not-ready (attempt ${attempt}/${maxAttempts}), waiting ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        lastErr = err;
        continue;
      }

      throw err; // unknown error — don't swallow
    }
  }

  throw lastErr; // exhausted all attempts
}

export class JobProgressTracker extends DurableObject {
  constructor( ctx: DurableObjectState,  env: Env) {
    super(ctx, env);
  }

  async increment(jobId: string, processed: number, failed: number, totalResumes?: number): Promise<{
    done: boolean;
    shouldTriggerScoring: boolean;
  }> {
    await this.ctx.storage.transaction(async (txn) => {
      const p = ((await txn.get<number>('processedCount')) ?? 0) + processed;
      const f = ((await txn.get<number>('failedCount'))   ?? 0) + failed;
      await txn.put('processedCount', p);
      await txn.put('failedCount',    f);

      // Store totalResumes if provided (first batch sets it; later batches can update)
      if (totalResumes !== undefined) {
        await txn.put('totalResumes', totalResumes);
      }
    });

    return this._checkCompletion(jobId);
  }

  async requestScoring(jobId: string, totalResumes: number): Promise<{
    done: boolean;
    shouldTriggerScoring: boolean;
  }> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put('scoringRequested', true);
      if (totalResumes !== undefined) {
        await txn.put('totalResumes', totalResumes);
      }
    });
    return this._checkCompletion(jobId);
  }

  private async _checkCompletion(jobId: string): Promise<{
    done: boolean;
    shouldTriggerScoring: boolean;
  }> {    
    const totalResumes = (await this.ctx.storage.get<number>('totalResumes')) ?? 0;
    if (!totalResumes || totalResumes === 0) return { done: false, shouldTriggerScoring: false };

    const processedCount    = (await this.ctx.storage.get<number>('processedCount'))    ?? 0;
    const failedCount       = (await this.ctx.storage.get<number>('failedCount'))       ?? 0;
    const scoringRequested  = (await this.ctx.storage.get<boolean>('scoringRequested')) ?? false;
    const scoringTriggered  = (await this.ctx.storage.get<boolean>('scoringTriggered')) ?? false;

    const done = (processedCount + failedCount) >= totalResumes;

    if (done && scoringRequested && !scoringTriggered) {
      await this.ctx.storage.put('scoringTriggered', true);
      return { done: true, shouldTriggerScoring: true };
    }

    return { done, shouldTriggerScoring: false };
  }
}

export class RerankProgressTracker extends DurableObject {
  constructor( ctx: DurableObjectState,  env: Env) {
    super(ctx, env);
  }

  async increment(jobId: string, totalChunks: number): Promise<{
    done: boolean;
  }> {
    await this.ctx.storage.transaction(async (txn) => {
      const current = (await txn.get<number>('completedChunks')) ?? 0;
      await txn.put('completedChunks', current + 1);
      // Store totalChunks on first call
      const stored = await txn.get<number>('totalChunks');
      if (!stored) await txn.put('totalChunks', totalChunks);
    });

    const completed = (await this.ctx.storage.get<number>('completedChunks')) ?? 0;
    const total     = (await this.ctx.storage.get<number>('totalChunks'))     ?? 0;
    const triggered = (await this.ctx.storage.get<boolean>('finalizeTrigger')) ?? false;

    if (total > 0 && completed >= total && !triggered) {
      await this.ctx.storage.put('finalizeTrigger', true);
      return { done: true };
    }

    return { done: false };
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

// ─── Pool of generic container slots ───────────────────────────────────────
const POOL_SIZE = 19;
let slotCounter = 0;
function nextSlot(): string {
  const slot = `worker-${slotCounter % POOL_SIZE}`;
  slotCounter++;
  return slot;
}

export default {

  // ── HTTP: thin proxy for all client-facing routes ─────────────────────────
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const method = request.method;

    // Internal DO query — container calls this to get totalResumes
    // (routed back through the worker so container never needs a DO binding)
    if (url.pathname === '/internal/job-total' && method === 'GET') {
      const jobId = url.searchParams.get('jobId')!;
      const container = getContainer(env.MY_BACKEND, 'default');
      return container.fetch(request);
    }

    // /trigger-scoring — worker validates then calls DO
    if (url.pathname === '/api/job/trigger-scoring' && method === 'POST') {
      try {
        const body    = await request.json() as { jobId: string };
        const jobId   = body.jobId;
        // Basic guard — full validation happens inside container
        if (!jobId) return new Response('jobId required', { status: 400 });

        // Forward to container for auth + DB validation first
        const container  = getContainer(env.MY_BACKEND, 'default');
        const validation = await container.fetch(
          new Request(`http://dummy/internal/validate-trigger`, {
            method:  'POST',
            headers: request.headers,
            body:    JSON.stringify({ jobId }),
          })
        );

        if (!validation.ok) return validation;

        const totalRes = await container.fetch(
          new Request(`http://dummy/internal/job-total?jobId=${jobId}`, {
            headers: { 'x-internal': '1' },
          })
        );
        const { totalResumes } = await totalRes.json() as { totalResumes: number };

        // Call DO
        const doId    = env.JOB_TRACKER.idFromName(jobId);
        const tracker = env.JOB_TRACKER.get(doId);
        const result  = await tracker.requestScoring(jobId, totalResumes);

        if (result.shouldTriggerScoring) {
          await env.RERANK_QUEUE.send({ jobId });
        }

        return new Response(JSON.stringify({ queued: result.shouldTriggerScoring }), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (e) {
        console.error("ERROR:", e);
        return Response.json(
          { error: String(e) },
          { status: 500 }
        );
      }
    }

    // Add inside worker fetch() before the default fallthrough

    if (url.pathname === '/internal/enqueue-extract' && method === 'POST') {
      const { messages } = await request.json() as { messages: ExtractMessage[] };
      await env.EXTRACT_QUEUE.sendBatch(
        messages.map((m) => ({ body: m, contentType: 'json' }))
      );
      return new Response('ok');
    }

    if (url.pathname === '/internal/enqueue-rerank-chunks' && method === 'POST') {
      const { chunks } = await request.json() as { chunks: RerankChunkMessage[] };
      await env.RERANK_CHUNKS.sendBatch(
        chunks.map((c) => ({ body: c, contentType: 'json' }))
      );
      return new Response('ok');
    }

  if (url.pathname === '/internal/reset-rerank-tracker' && method === 'POST') {
    const { jobId } = await request.json() as { jobId: string };
    const doId      = env.RERANK_TRACKER.idFromName(jobId);
    const tracker   = env.RERANK_TRACKER.get(doId);
    await tracker.reset();
    return new Response('ok');
  }

  // rerank-finalize queue consumer forwards here — already handled in queue()
  // but expose as HTTP too for manual retries
  if (url.pathname === '/internal/trigger-rerank-finalize' && method === 'POST') {
    const { jobId } = await request.json() as { jobId: string };
    await env.RERANK_FINALIZE.send({ jobId });
    return new Response('ok');
  }
    // All other routes → default container instance (API layer)
    const container = getContainer(env.MY_BACKEND, 'default');
    return container.fetch(request);
  },

  // ── Queue: resume-extract consumer ────────────────────────────────────────
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {

    if (batch.queue === 'resume-extract') {
      // Map resumeId → original queue message for granular ack/retry
      const msgMap = new Map<string, (typeof batch.messages)[number]>();
      const groups = new Map<string, ExtractMessage[]>();

      batch.messages.forEach((msg, i) => {
        const m = msg.body as ExtractMessage;
        const slot = `worker-${i % POOL_SIZE}`;
        if (!groups.has(slot)) groups.set(slot, []);
        groups.get(slot)!.push(m);
        msgMap.set(m.resumeId, msg);  // ← keep reference to original msg
      });

      console.log(`[extract] batch size=${batch.messages.length} slots=${groups.size}`);

      // allSettled — one slot failure does NOT affect others
      await Promise.allSettled(
        [...groups.entries()].map(async ([slot, messages]) => {
          console.log(`[extract] slot=${slot} sending ${messages.length} resumes`);

          let res: Response;
          try {
            res =await fetchWithRetry(env, slot, 'http://dummy/internal/process-batch','POST',
              { 'content-type': 'application/json', 'x-internal': '1' }, { messages });

            // const container = getContainer(env.MY_BACKEND, slot);
            // res = await container.fetch(
            //   new Request('http://dummy/internal/process-batch', {
            //     method: 'POST',
            //     headers: { 'content-type': 'application/json', 'x-internal': '1' },
            //     body: JSON.stringify({ messages }),
            //   })
            // );
          } catch (err) {
            // Container unreachable / crashed — retry all messages in this slot
            console.error(`[extract] slot=${slot} threw: ${err}`);
            for (const m of messages) {
              msgMap.get(m.resumeId)?.retry();
            }
            return; // don't throw — let other slots succeed
          }

          if (!res.ok) {
            const errBody = await res.text();
            console.error(`[extract] slot=${slot} status=${res.status} body=${errBody}`);
            // Container returned error — retry all in this slot
            for (const m of messages) {
              msgMap.get(m.resumeId)?.retry();
            }
            return;
          }

          const { results } = await res.json() as { results: BatchItemResult[] };
          console.log(`[extract] slot=${slot} results=${JSON.stringify(results)}`);

          // Per-resume granular ack/retry based on what container reports
          for (const r of results) {
            if (r.outcome === 'processed') {
              msgMap.get(r.resumeId)?.ack();
            } else {
              if (r.retriable) {
                console.warn(`[extract] resumeId=${r.resumeId} failed, re-enqueueing`);
                await env.EXTRACT_QUEUE.send(
                  { resumeId: r.resumeId, jobId: r.jobId },
                  { delaySeconds: 5 }
                );
              } else {
                console.error(`[extract] resumeId=${r.resumeId} permanently failed, dropping`);
              }
              msgMap.get(r.resumeId)?.ack(); // ack either way — retry is via new message
            }
          }

          // Handle any resumeIds the container didn't report back at all
          const reportedIds = new Set(results.map(r => r.resumeId));
          for (const m of messages) {
            if (!reportedIds.has(m.resumeId)) {
              console.warn(`[extract] resumeId=${m.resumeId} missing from container response, retrying`);
              msgMap.get(m.resumeId)?.retry();
            }
          }
        })
      );
    }
    // if (batch.queue === 'resume-extract') {
    //   // Round-robin across pool slots — no job affinity
    //   const groups = new Map<string, ExtractMessage[]>();

    //   batch.messages.forEach((msg, i) => {
    //     const slot = `worker-${i % POOL_SIZE}`;
    //     if (!groups.has(slot)) groups.set(slot, []);
    //     groups.get(slot)!.push(msg.body as ExtractMessage);
    //   });

    //   await Promise.all([...groups.entries()].map(async ([slot, messages]) => {
    //     const container = getContainer(env.MY_BACKEND, slot);

    //     const res = await container.fetch(
    //       new Request('http://dummy/internal/process-batch', {
    //         method:  'POST',
    //         headers: { 'content-type': 'application/json', 'x-internal': '1' },
    //         body:    JSON.stringify({ messages }),
    //       })
    //     );

    //     if (!res.ok) {
    //       // Let queue retry the whole batch
    //       throw new Error(`Container ${slot} failed: ${res.status}`);
    //     }

    //     const { results } = await res.json() as { results: BatchItemResult[] };

    //     // Group outcomes by jobId → call each job's DO once per batch
    //     const byJob = new Map<string, { processed: number; failed: number }>();
    //     for (const r of results) {
    //       if (!byJob.has(r.jobId)) byJob.set(r.jobId, { processed: 0, failed: 0 });
    //       const counts = byJob.get(r.jobId)!;
    //       r.outcome === 'processed' ? counts.processed++ : counts.failed++;
    //     }

    //     await Promise.all([...byJob.entries()].map(async ([jobId, counts]) => {
    //       const doId    = env.JOB_TRACKER.idFromName(jobId);
    //       const tracker = env.JOB_TRACKER.get(doId);
    //       const result  = await tracker.increment(jobId, counts.processed, counts.failed);

    //       if (result.shouldTriggerScoring) {
    //         await env.RERANK_QUEUE.send({ jobId });
    //       }
    //     }));
    //   }));
    // }

    // Inside worker queue() — add alongside existing handlers
    if (batch.queue === 'rerank-chunks') {
      await Promise.all(batch.messages.map(async (msg) => {
        const { jobId, resumeIds, anchorIds, chunkIndex, totalChunks, jobData } =
          msg.body as RerankChunkMessage;

        const slot      = `worker-${chunkIndex % POOL_SIZE}`;
        const container = getContainer(env.MY_BACKEND, slot);

        const res = await container.fetch(
          new Request('http://dummy/internal/rerank-chunk', {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-internal': '1' },
            body:    JSON.stringify({ jobId, resumeIds, anchorIds, chunkIndex, jobData }),
          })
        );

        if (!res.ok) {
          const errorBody :any = await res.json();
          throw new Error(`Rerank chunk ${chunkIndex} failed: ${errorBody.message}`);
          console.log(`Error ${errorBody.message}`);
        }

        // Chunk results are now persisted in RerankChunkResult by the container.
        // Tell the DO this chunk is done.
        const doId    = env.RERANK_TRACKER.idFromName(jobId);
        const tracker = env.RERANK_TRACKER.get(doId);
        const result  = await tracker.increment(jobId, totalChunks);

        if (result.done) {
          // All chunks complete — trigger finalization
          await env.RERANK_FINALIZE.send({ jobId });
        }
      }));
    }

    if (batch.queue === 'rerank-finalize') {
      for (const msg of batch.messages) {
        const { jobId } = msg.body as { jobId: string };
        const slot      = nextSlot();
        const container = getContainer(env.MY_BACKEND, slot);

        const res = await container.fetch(
          new Request('http://dummy/internal/rerank-finalize', {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-internal': '1' },
            body:    JSON.stringify({ jobId }),
          })
        );

        if (!res.ok) throw new Error(`Rerank finalize failed for job ${jobId}: ${res.status}`);
      }
    }

    if (batch.queue === 'rerank-job') {
      // Single message per job — trigger full rerank orchestration
      for (const msg of batch.messages) {
        const { jobId } = msg.body as { jobId: string };
        const slot      = nextSlot();
        const container = getContainer(env.MY_BACKEND, slot);

        const res = await container.fetch(
          new Request('http://dummy/internal/rerank-job', {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-internal': '1' },
            body:    JSON.stringify({ jobId }),
          })
        );

        if (!res.ok) throw new Error(`Rerank job failed: ${res.status}`);
      }
    }
  },
};