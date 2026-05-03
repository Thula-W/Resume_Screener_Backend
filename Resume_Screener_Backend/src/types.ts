export interface constraints{
    yearsOfExperience: number,
    education: string,
    languages: string[],
    certifications: string[]
}

export interface EvaluationPair {
  cv: File;
  verdict: string;
}

export interface AddEvaluationsRequest {
  jobId: string;
  pairs: EvaluationPair[]; // 1–3 pairs
}

export interface JobData {
  title: string;
  overview: string | null;
  bioText: string | null;
  skillsText: string | null;
  experienceText: string | null;
}

export interface ChunkRow {
  resume_id: string;
  skills_sem:  number;
  skills_kw:   number;
  exp_sem:     number;
  exp_kw:      number;
  bio_sem:     number;
  bio_kw:      number;
}

export interface ResumeScore {
  resumeId:        string;
  skillScore:      number;
  experienceScore: number;
  bioScore:        number;
  finalScore:      number;
  // explanation:     string;
}

export interface BatchResult {
  total:      number;
  succeeded:  number;
  failed:     number;
  skipped:    number;   // resumes with suspiciously zero scores (bad embedding)
  scores:     ResumeScore[];
  failures:   { resumeId: string; error: string }[];
  durationMs: number;
}

export interface RerankSaveItem {
  screeningResultId: string;
  rerankedScore: number;
}