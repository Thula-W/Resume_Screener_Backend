import { Router } from "express";
import { authenticate } from "../middleware/auth.ts";
import { confirmUpload, uploadIntent } from "../controllers/resume.controlls.ts";

const router = Router();

router.post("/upload-intent", authenticate, uploadIntent);
router.post("/upload-confirm", authenticate, confirmUpload);

export default router;
