import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { confirmUpload, uploadIntent } from "../controllers/resume.controlls";

const router = Router();

router.post("/upload-intent", authenticate, uploadIntent);
router.post("/upload-confirm", authenticate, confirmUpload);

export default router;
