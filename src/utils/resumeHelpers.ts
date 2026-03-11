import { supabase } from "./supabase.ts";
import {prisma} from "./prisma.ts";
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openAiClient } from "./openai.ts";

// ---------- helpers --------------------------------
const extractTextFromPDF = async (buffer: Buffer) => {
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

//----------------------------------------------------------
export const processResume = async (resumeId: string) => {
    console.log(resumeId);
    try {
      const resume = await prisma.resume.findUnique({
        where: { id: resumeId },
      });
      console.log(resume.storagePath)
      if (!resume) throw new Error("Resume not found");

      // const paths = resume.storagePath.split("/");

      const fileBuffer = await downloadResumeFile(
          'resumes',
          resume.storagePath
      );

      const text = await extractTextFromPDF(fileBuffer);
      console.log(text)

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
      throw error;
    }
    
}

export const sanitizeText = async (text: string) => {
  const prompt = `You are a professional resume parsing engine. Your task is to extract structured information from the provided text into a clean, valid JSON format.

    ### Extraction Rules:
    1. **JSON Only:** Return ONLY valid JSON. Do not include introductory text, markdown code blocks (unless specified), or conversational filler.
    2. **Handle Missing Data:** If a field or specific detail is missing, return ''.
    no need to extract references.
    Do not extract personal information

    ### Target Schema:
    {
      "summary": "",
      "skills": [],
      "work_experience": [
        {
          "company": "",
          "role": "",
          "location": "",
          "dates": "",
          "description": ["bullet 1", "bullet 2"]
        }
      ],
      "projects": [
        {
          "title": "",
          "description": ["bullet 1", "bullet 2"]
        }
      ],
      "education": [
        { "institution": "", "degree": "", "dates": "" }
      ],
      "other_sections": [
        {
          "title": "...",
          "details": ["Detail 1", "Detail 2"]
        }
      ]
    }

    ### Resume Text:
    ${text}`;

    const response = await openAiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "You extract structured resume data."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" }
    });

    const json = response.choices[0].message.content;

    return JSON.parse(json!);
}

// const text = await processResume("8f55476f-a498-41b2-9ba1-adf0762329b1")
const text =  await processResume("60061a06-c5eb-4e0c-bf35-207350f19b87")

console.log("---- Sanitized Output ----");
const sanitized = await sanitizeText(text);
console.log(sanitized);
