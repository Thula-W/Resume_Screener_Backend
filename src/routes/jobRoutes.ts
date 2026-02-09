import { Router } from "express";
import { authenticate } from "../middleware/auth.ts";

import { addJob } from "../controllers/job.controlls.ts";

const router = Router();

router.post('/',authenticate, addJob);


export default router;
