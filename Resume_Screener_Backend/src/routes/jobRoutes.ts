import { Router } from "express";
import { authenticate } from "../middleware/auth";

import { addJob, addEvaluations, checkJobStatus, deleteJob } from "../controllers/job.controlls";
import { upload } from "../middleware/multer";
import { handleCohereRerankJob } from "../services/cohereRerank";
import { handleGPTRankJob } from "../services/gptRank";
import { handleRerankJob } from "../services/rerank.service";
import { getRankingsForJob } from "../controllers/job.controlls"

const router = Router();

router.post('/',authenticate, addJob);

router.post('/:jobId/evals',authenticate, upload.fields([
    { name: "cv_0", maxCount: 1 },
    { name: "cv_1", maxCount: 1 },
    { name: "cv_2", maxCount: 1 },
  ]), addEvaluations);

router.post('/rerank-job',authenticate, checkJobStatus, async (req, res) => {
  const { jobId } = req.body;
  try {
    const cohereResult = await handleCohereRerankJob(jobId);
    if (cohereResult.shouldRank) {
      // await handleRerankJob(jobId); 
      const rankResult = await handleGPTRankJob(jobId);
      res.json(rankResult);
    }
    res.json({ success: false });
  } catch (err) {
    console.error('Rerank job failed:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/delete-job', authenticate, deleteJob);

router.post('/rankings',authenticate, getRankingsForJob)

export default router;
