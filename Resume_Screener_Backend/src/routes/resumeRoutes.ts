import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { confirmUpload, downloadBulkResumes, getResumePresignedUrl, uploadIntent } from "../controllers/resume.controlls";

const router = Router();

router.post("/upload-intent", authenticate, uploadIntent);
router.post("/upload-confirm", authenticate, confirmUpload);
router.get("/:resumeId/url", authenticate, getResumePresignedUrl);
router.post("/download-bulk", authenticate, downloadBulkResumes);

export default router;
