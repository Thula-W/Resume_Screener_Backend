import { Router } from "express";
import { authenticate } from "../middleware/auth";

import { getMe } from "../controllers/user.controller";

const router = Router();

router.get('/',authenticate, getMe);

export default router;
