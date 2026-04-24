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