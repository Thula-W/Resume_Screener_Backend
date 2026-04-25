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
interface BatchItemResult  { resumeId: string; jobId: string; outcome: 'processed' | 'failed'; }
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

export class JobProgressTracker extends DurableObject {
  constructor( ctx: DurableObjectState,  env: Env) {
    super(ctx, env);
  }

  async increment(jobId: string, processed: number, failed: number): Promise<{
    done: boolean;
    shouldTriggerScoring: boolean;
  }> {
    await this.ctx.storage.transaction(async (txn) => {
      const p = ((await txn.get<number>('processedCount')) ?? 0) + processed;
      const f = ((await txn.get<number>('failedCount'))   ?? 0) + failed;
      await txn.put('processedCount', p);
      await txn.put('failedCount',    f);
    });

    return this._checkCompletion(jobId);
  }

  async requestScoring(jobId: string): Promise<{
    done: boolean;
    shouldTriggerScoring: boolean;
  }> {
    await this.ctx.storage.put('scoringRequested', true);
    return this._checkCompletion(jobId);
  }

  private async _checkCompletion(jobId: string): Promise<{
    done: boolean;
    shouldTriggerScoring: boolean;
  }> {
    // Always read totalResumes fresh from DB — handles multi-batch uploads
    const res = await fetch(
      `http://localhost/internal/job-total?jobId=${jobId}`,
      { headers: { 'x-internal': '1' } }
    );
    // We call our own container's internal endpoint (see section 4)
    const { totalResumes } = await res.json() as { totalResumes: number };

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
    if (url.pathname === '/api/resumes/trigger-scoring' && method === 'POST') {
      const body    = await request.clone().json() as { jobId: string };
      const jobId   = body.jobId;

      // Basic guard — full validation happens inside container
      if (!jobId) return new Response('jobId required', { status: 400 });

      // Forward to container for auth + DB validation first
      const container  = getContainer(env.MY_BACKEND, 'default');
      const validation = await container.fetch(
        new Request(`${url.origin}/internal/validate-trigger`, {
          method:  'POST',
          headers: request.headers,
          body:    JSON.stringify({ jobId }),
        })
      );

      if (!validation.ok) return validation;

      // Call DO
      const doId    = env.JOB_TRACKER.idFromName(jobId);
      const tracker = env.JOB_TRACKER.get(doId);
      const result  = await tracker.requestScoring(jobId);

      if (result.shouldTriggerScoring) {
        await env.RERANK_QUEUE.send({ jobId });
      }

      return new Response(JSON.stringify({ queued: result.shouldTriggerScoring }), {
        headers: { 'content-type': 'application/json' },
      });
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
      // Round-robin across pool slots — no job affinity
      const groups = new Map<string, ExtractMessage[]>();

      batch.messages.forEach((msg, i) => {
        const slot = `worker-${i % POOL_SIZE}`;
        if (!groups.has(slot)) groups.set(slot, []);
        groups.get(slot)!.push(msg.body as ExtractMessage);
      });

      await Promise.all([...groups.entries()].map(async ([slot, messages]) => {
        const container = getContainer(env.MY_BACKEND, slot);

        const res = await container.fetch(
          new Request('https://api.azendly.net/internal/process-batch', {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-internal': '1' },
            body:    JSON.stringify({ messages }),
          })
        );

        if (!res.ok) {
          // Let queue retry the whole batch
          throw new Error(`Container ${slot} failed: ${res.status}`);
        }

        const { results } = await res.json() as { results: BatchItemResult[] };

        // Group outcomes by jobId → call each job's DO once per batch
        const byJob = new Map<string, { processed: number; failed: number }>();
        for (const r of results) {
          if (!byJob.has(r.jobId)) byJob.set(r.jobId, { processed: 0, failed: 0 });
          const counts = byJob.get(r.jobId)!;
          r.outcome === 'processed' ? counts.processed++ : counts.failed++;
        }

        await Promise.all([...byJob.entries()].map(async ([jobId, counts]) => {
          const doId    = env.JOB_TRACKER.idFromName(jobId);
          const tracker = env.JOB_TRACKER.get(doId);
          const result  = await tracker.increment(jobId, counts.processed, counts.failed);

          if (result.shouldTriggerScoring) {
            await env.RERANK_QUEUE.send({ jobId });
          }
        }));
      }));
    }

    // Inside worker queue() — add alongside existing handlers
    if (batch.queue === 'rerank-chunks') {
      await Promise.all(batch.messages.map(async (msg) => {
        const { jobId, resumeIds, anchorIds, chunkIndex, totalChunks } =
          msg.body as RerankChunkMessage;

        const slot      = `worker-${chunkIndex % POOL_SIZE}`;
        const container = getContainer(env.MY_BACKEND, slot);

        const res = await container.fetch(
          new Request('https://api.azendly.net/internal/rerank-chunk', {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-internal': '1' },
            body:    JSON.stringify({ jobId, resumeIds, anchorIds, chunkIndex }),
          })
        );

        if (!res.ok) throw new Error(`Rerank chunk ${chunkIndex} failed: ${res.status}`);

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
          new Request('https://api.azendly.net/internal/rerank-finalize', {
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
          new Request('https://api.azendly.net/internal/rerank-job', {
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