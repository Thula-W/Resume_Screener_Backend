import { Router } from "express";
import { authenticate } from "../middleware/auth";

// import { getMe } from "../controllers/user.controller";
import { getJobsOfUser } from "../controllers/job.controlls";

const router = Router();

// router.get('/',authenticate, getMe);
router.get('/jobs', authenticate, getJobsOfUser);
export default router;