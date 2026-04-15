interface constraints{
    yearsOfExperience: number,
    education: string,
    languages: string[],
    certifications: string[]
}

interface EvaluationPair {
  cv: File;
  verdict: string;
}

export interface AddEvaluationsRequest {
  jobId: string;
  pairs: EvaluationPair[]; // 1–3 pairs
}