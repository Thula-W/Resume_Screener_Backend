import { supabase } from "./supabase.ts";
import {prisma} from "./prisma.ts";
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export const extractTextFromPDF = async (buffer: Buffer) => {
  const uint8Array = new Uint8Array(buffer);
  const pdf = await pdfjs.getDocument({ data: uint8Array }).promise;
  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((item: any) => item.str);
    text += strings.join(" ") + "\n";
  }
  return text;
};

const downloadResumeFile = async (
  bucket: string,
  filePath: string
): Promise<Buffer> => {
  console.log ('bucket', bucket);
  console.log ('filePath', filePath);
  const { data, error } = await supabase
    .storage
    .from(bucket)
    .download(filePath);

 if (error) {
    // Log the full error to see status codes (e.g., 404, 403)
    console.error("Storage Error Details:", error);
    throw new Error(`Download failed for ${filePath}: ${error.message || 'File not found or access denied'}`);
  }

  if (!data) throw new Error("Download returned no data.");

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

export const processResume = async (resumeId: string) => {
    console.log(resumeId);
    try {
      const resume = await prisma.resume.findUnique({
        where: { id: resumeId },
      });
      console.log(resume.storagePath)
      if (!resume) throw new Error("Resume not found");

      const paths = resume.storagePath.split("/");

      const fileBuffer = await downloadResumeFile(
          paths[0],
          paths.slice(1).join("/")
      );

      const text = await extractTextFromPDF(fileBuffer);

      //const embedding = await generateEmbedding(text);

      // await prisma.resume.update({
      //     where: { id: resumeId },
      //     data: {
      //     //embedding,
      //     status: "PARSED",
      //     },
      // });
      return text;
    } catch (error) {
      console.log("error:", error);
    }
    
}

const fileBuffer = await downloadResumeFile(
          'resumes',
          "fELPTDWswZVfCd14UYtWXqPZvSK2/ML_Thulana_Weerasekara.pdf"
      );

const text = await extractTextFromPDF(fileBuffer);
console.log(text);