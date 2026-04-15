import { Router } from "express";
import { authenticate } from "../middleware/auth.ts";

import { addJob, addEvaluations } from "../controllers/job.controlls.ts";
import { upload } from "../middleware/multer.ts";

const router = Router();

router.post('/',authenticate, addJob);
router.post('/:jobId/evals',authenticate, upload.fields([
    { name: "cv_0", maxCount: 1 },
    { name: "cv_1", maxCount: 1 },
    { name: "cv_2", maxCount: 1 },
  ]), addEvaluations);

export default router;
