import { Router } from "express";
import { authenticate } from "../middleware/auth";

import { addJob, addEvaluations, checkJobStatus, deleteJob } from "../controllers/job.controlls";
import { upload } from "../middleware/multer";
import { handleCohereRerankJob } from "../services/cohereRerank";
import { handleRerankJob } from "../services/rerank.service";

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
    const result = await handleCohereRerankJob(jobId);
    if (result.shouldRank) {
      await handleRerankJob(jobId); 
      res.json({ addedToRank : true });
    }
    res.json({ addedToRank : false });
  } catch (err) {
    console.error('Rerank job failed:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.post('/delete-job', authenticate, deleteJob);

export default router;
