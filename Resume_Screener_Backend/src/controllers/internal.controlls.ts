import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { processResume } from '../services/resumeProcess.service';

export const processBatch = async (req: Request, res: Response) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    console.error("Invalid body format. Expected { messages: [...] }");
    return res.status(400).json({ error: "Invalid request format", received: req.body });
  }

  const results = await Promise.all(
    messages.map(async (msg) => {
      const { resumeId, jobId } = msg;
      try {
        const job = await prisma.job.findUnique({ where: { id: jobId } });
        // ── Guard 1: idempotency — skip if already past UPLOADED ──────────
        const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
        if (!resume) return { resumeId, jobId, outcome: 'failed' as const };

        if (!['UPLOADED', 'PROCESSING','FAILED'].includes(resume.status)) {
          // Already processed in a previous attempt — report as processed
          // so the DO counter still advances correctly
          return { resumeId, jobId, outcome: 'processed' as const };
        }

        if (resume.status === 'FAILED') {
          if (resume.retryCount >= 3) {
            return { resumeId, jobId, outcome: 'failed' as const, retriable: false };
          }

          await prisma.resume.update({
            where: { id: resumeId },
            data:  { status: 'UPLOADED', retryCount: { increment: 1 } },
          });

          return { resumeId, jobId, outcome: 'failed' as const, retriable: true };

        }
        // ── Guard 2: atomic claim — only one worker processes this resume ──
        const claimed = await prisma.resume.updateMany({
          where: { id: resumeId, status: 'UPLOADED' },
          data:  { status: 'PROCESSING' },
        });

        if (claimed.count === 0) {
          // Another worker claimed it — skip, do not double-count
          return null; // filtered out below
        }

        // ── Process ────────────────────────────────────────────────────────
        await processResume(resumeId, resume.jobId, job?.constraints);
        return { resumeId, jobId, outcome: 'processed' as const };

      } catch (err) {
        console.error(`Failed resume ${resumeId}:`, err);
        const failedResume = await prisma.resume.update({
          where: { id: resumeId },
          data:  { status: 'FAILED', retryCount: { increment: 1 } },
        });
        if (failedResume.retryCount >= 3) {
          return { resumeId, jobId, outcome: 'failed' as const, retriable: false };
        }
        return { resumeId, jobId, outcome: 'failed' as const, retriable: true };
      }
    })
  );

  // Filter out nulls (skipped — claimed by another worker)
  const finalResults = results.filter(Boolean);
  return res.json({ results: finalResults });
};