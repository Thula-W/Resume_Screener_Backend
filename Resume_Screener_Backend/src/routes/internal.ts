// src/routes/internalRoutes.ts

import { Router } from 'express';
import { processBatch } from '../controllers/internal.controlls';
import { getJobTotal, validateTrigger } from '../controllers/resume.controlls';
import { handleRerankJob, handleRerankChunk, handleRerankFinalize } from '../services/rerank.service';
import { authenticate } from '../middleware/auth';
import { JobData } from '../types';
import { handleCohereRerankJob } from '../services/cohereRerank';

const router = Router();

// Called by worker queue consumer
router.post('/process-batch',processBatch);

// Called by worker to read totalResumes for DO
router.get('/job-total', getJobTotal);

// Called by worker before calling DO for trigger-scoring
router.post('/validate-trigger', authenticate, validateTrigger);

// Called by worker rerank-job queue consumer  (the earlier implementaion using gpt)
router.post('/rerank-job', async (req, res) => {
  const { jobId } = req.body;
  try {
    await handleRerankJob(jobId); 
    res.json({ ok: true });
  } catch (err) {
    console.error('Rerank job failed:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Called by worker rerank-chunks queue consumer
router.post('/rerank-chunk', async (req, res) => {
  const { jobId, resumeIds, anchorIds, chunkIndex,jobData } = req.body as {
    jobId:      string;
    resumeIds:  string[];
    anchorIds:  string[];
    chunkIndex: number;
    jobData:    JobData;
  };
  try {
    await handleRerankChunk(jobId, resumeIds, anchorIds, chunkIndex, jobData);
    res.json({ ok: true });
  } catch (err : any) {
    console.error('Rerank chunk failed:', err);
    res.status(500).json({message: err.message});
  }
});

router.post('/rerank-finalize', async (req, res) => {
  const { jobId } = req.body as { jobId: string };
  try {
    await handleRerankFinalize(jobId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Rerank finalize failed:', err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;