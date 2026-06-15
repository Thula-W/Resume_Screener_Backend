import { Router } from "express";
import { authenticate } from "../middleware/auth";

// import { getMe } from "../controllers/user.controller";
import { getJobsOfUser } from "../controllers/job.controlls";
import { getCreditDetails , addFeedBack } from "../controllers/user.controller";

const router = Router();

// router.get('/',authenticate, getMe);
router.get('/jobs', authenticate, getJobsOfUser);
router.post('/credits', authenticate, getCreditDetails );
router.post('/feedback', authenticate, addFeedBack)

export default router;