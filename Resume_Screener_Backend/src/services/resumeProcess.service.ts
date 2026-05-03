import 'dotenv/config';
import { prisma } from '../config/prisma';
import { downloadResumeFile, extractTextFromPDF, extractJson, convertJsonToText, combineResumeText, checkHardConstraints } from '../utils/resumeHelpers';
import { processResumeEmbeddings } from '../utils/embeddingHelpers';
import { scoreSingleResume } from '../utils/ranking/score';

export const processResume = async (resumeId: string, jobId: string, constraints: any) => {
  try{
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume) throw new Error('Resume not found');

    const fileBuffer = await downloadResumeFile(process.env.R2_BUCKET_NAME || 'azendly-resumes', resume.storagePath);
    const text       = await extractTextFromPDF(fileBuffer);
    const json       = await extractJson(text) || '{}';
    const bucketTexts = convertJsonToText(JSON.parse(json));

    const { attributes, ...restBuckets } = bucketTexts;
    const content   = combineResumeText(restBuckets);
    const qualified = checkHardConstraints(attributes, constraints);
    const status    = qualified ? 'PARSED' : 'DISQUALIFIED';

    await prisma.resume.update({
      where: { id: resumeId },
      data:  { content, status },
    });

    if (!qualified) return;

    // ── Embed ──────────────────────────────────────────────────────────────
    await processResumeEmbeddings({ resumeId, buckets: restBuckets });
    // status is now EMBEDDED inside processResumeEmbeddings

    // ── Score immediately after embedding (end of Pipeline 1) ─────────────
    await scoreSingleResume(resumeId, jobId);
      // await prisma.resume.update({
      //   where: { id: resumeId },
      //   data:  { status: 'SCORED' },
      // });
  } catch (err) {
    // Processing failure doesn't fail the resume — embedding succeeded
    console.error(`Processing failed for ${resumeId}`, err);
    throw err;
  }
};