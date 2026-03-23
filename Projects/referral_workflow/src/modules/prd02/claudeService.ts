/**
 * AI sufficiency assessment for PRD-02 clinician review.
 *
 * Uses Google Gemini (gemini-1.5-flash) to evaluate whether an inbound referral
 * has sufficient clinical information for a specialist to act on it.
 * This is advisory only — the result is shown in the UI but never gates the workflow.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { ExtendedReferralData } from '../prd01/cdaParser';

export interface SufficiencyAssessment {
  sufficient: boolean;
  summary: string;      // 1–2 sentence plain-language assessment
  concerns: string[];   // specific gaps or flags
}

const FALLBACK: SufficiencyAssessment = {
  sufficient: true,
  summary: 'AI assessment unavailable.',
  concerns: [],
};

function buildPromptContext(data: ExtendedReferralData): string {
  return [
    `Patient: ${data.patient.firstName} ${data.patient.lastName}, DOB: ${data.patient.dateOfBirth}`,
    `Reason for Referral: ${data.reasonForReferral || '(not provided)'}`,
    `Problems: ${data.problems.length > 0 ? data.problems.join(', ') : '(none listed)'}`,
    `Allergies: ${data.allergies.length > 0 ? data.allergies.join(', ') : '(none listed)'}`,
    `Medications: ${data.medications.length > 0 ? data.medications.join(', ') : '(none listed)'}`,
    `Diagnostic Results: ${data.diagnosticResults.length > 0 ? data.diagnosticResults.join(', ') : '(none listed)'}`,
    `Missing optional sections: ${data.missingOptionalSections.length > 0 ? data.missingOptionalSections.join(', ') : 'none'}`,
  ].join('\n');
}

/**
 * Calls Gemini to assess clinical sufficiency of the referral.
 * Falls back to FALLBACK if the API call fails or returns an unexpected shape.
 */
export async function assessSufficiency(data: ExtendedReferralData): Promise<SufficiencyAssessment> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[ClaudeService] GEMINI_API_KEY not set — skipping assessment');
    return FALLBACK;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are a clinical referral coordinator assistant. A referral has been received with the following information:

${buildPromptContext(data)}

Evaluate whether this referral contains sufficient clinical information for a specialist to review and act on it. Consider whether the reason for referral is clear, whether relevant clinical history is present, and whether any critical information appears to be missing.

Respond with a JSON object in this exact format:
{
  "sufficient": true or false,
  "summary": "one or two sentence plain-language assessment",
  "concerns": ["concern 1", "concern 2"]
}

Return only the JSON object with no additional text.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Strip markdown code fences if Gemini wraps the response
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(json) as SufficiencyAssessment;

    if (typeof parsed.sufficient === 'boolean' && typeof parsed.summary === 'string' && Array.isArray(parsed.concerns)) {
      return parsed;
    }

    console.warn('[ClaudeService] Unexpected response shape — using fallback');
    return FALLBACK;
  } catch (err) {
    console.error('[ClaudeService] assessSufficiency failed:', err);
    return FALLBACK;
  }
}
