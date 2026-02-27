import { prisma } from "../utils/prisma.ts";
import type { Request, Response } from "express";
import { supabase } from "../utils/supabase.ts";


// export const createResume = async (req: Request, res: Response) => {
//   const { jobId, resumeUrl } = req.body!;

//    if (!resumeUrl) {
//       return res.status(400).json({ error: "resumeUrl is required" });
//     }
//     try{
//     const resume = await prisma.resume.create({
//       data: {
//         jobId,
//         storagePath : resumeUrl,
//       },
//     });
//     res.json(resume);

//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Something went wrong" });
//   }
// }

export const uploadIntent = async (req: Request, res: Response) => {
  try {
    const firebaseUid = req.user.firebaseUid;
    const jobId = req.body.jobId;

    const job = await prisma.job.findUnique({
      where: { id: jobId },
    })
    const user = await prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (job.userId !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const resumeCount = await prisma.resume.count({
      where: { jobId: jobId },
    });

    if (resumeCount >= 5) {
      return res.status(403).json({ error: "Resume limit reached" });
    }

    const fileId = `${Date.now()}_${crypto.randomUUID()}`;
    const storagePath = `${firebaseUid}/${fileId}.pdf`;

    const resume = await prisma.resume.create({
      data: {
        jobId: jobId,
        storagePath: storagePath,
        status: "PENDING",
      },
    });
    res.json({
      resumeId : resume.id,
      storagePath: storagePath,
      constraints: {
        maxSizeMB: 5,
        allowedTypes: ["application/pdf"],
      },   
  })}
  catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create upload intent" });
  }
}

export const confirmUpload = async (req: Request, res: Response) => {
  try {
    const firebaseUid = req.user.firebaseUid;
    const { resumeId, jobId , storagePath } = req.body;
    const file = req.file; 

    if (!file || file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "Only PDF files allowed" });
    }

    // const user = await prisma.user.findUnique({
    //   where: { firebaseUid: firebaseUid },
    // });

    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
    });

    if (!resume || resume?.jobId !== jobId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (resume.status !== "PENDING") {
      return res.status(400).json({ error: "Invalid resume state" });
    }

    const paths = resume.storagePath.split("/");
    const { error: uploadError } = await supabase.storage
      .from("resumes")
      .upload(paths.slice(1).join("/"), file.buffer, {
        contentType: "application/pdf",
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const { data: signedUrl } = await supabase.storage
      .from("resumes")
      .createSignedUrl(storagePath, 60 * 60 * 24 * 2); 

    await prisma.resume.update({
      where: { id: resumeId },
      data: {
        // fileUrl: signedUrl?.signedUrl,
        status: "UPLOADED",
        uploadedAt: new Date(),
      },
    });

    // 🔥 Fire-and-forget async parsing trigger
     // triggerResumeParsing(resumeId);

    res.json({
      success: true,
      resumeId,
      fileUrl: signedUrl?.signedUrl,
    });

  } catch (err) {
    console.error("Upload failed:", err);

    // await prisma.resume.update({
    //   where: { id: resumeId },
    //   data: { status: "FAILED" },
    // });

    res.status(500).json({ success:false,error: "Upload failed" });
  }
};
// export const confirmUpload = async (req: Request, res: Response) => {
//   try {
//     const firebaseUid = req.user.firebaseUid;
//     const { resumeId, jobId } = req.body;

//     const user = await prisma.user.findUnique({
//       where: { firebaseUid: firebaseUid },
//     });

//     const resume = await prisma.resume.findUnique({
//       where: { id: resumeId },
//     });

//     if (!resume || resume?.jobId !== jobId) {
//       return res.status(403).json({ error: "Forbidden" });
//     }

//     if (resume.status !== "PENDING") {
//       return res.status(400).json({ error: "Invalid resume state" });
//     }

//     const { data, error } = await supabase.storage
//       .from("resumes")
//       .list(firebaseUid, {
//         search: resume.storagePath.split("/")[2],
//       });

//     if (error || !data || data.length === 0) {
//       return res.status(400).json({ error: "File not found in storage" });
//     }

//     await prisma.resume.update({
//       where: { id: resumeId },
//       data: {
//         status: "UPLOADED",
//         uploadedAt: new Date(),
//       },
//     });

//     const { data: signed } = await supabase.storage
//       .from("resumes")
//       .createSignedUrl(resume.storagePath, 300);

//     res.json({
//       resumeId,
//       status: "UPLOADED",
//       signedUrl: signed?.signedUrl, // optional
//     });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Failed to confirm upload" });
//   }
// };



