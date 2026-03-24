/**
 * Uses Gemini to structure free-text clinical notes into discrete
 * Consult Note C-CDA sections.
 *
 * Follows the same pattern as claudeService.ts (PRD-02 sufficiency assessment).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

export interface ConsultNoteSections {
  chiefComplaint: string;
  historyOfPresentIllness: string;
  assessment: string;
  plan: string;
  physicalExam: string;
}

export interface PatientContext {
  firstName: string;
  lastName: string;
  reasonForReferral: string;
}

const FALLBACK_SECTIONS: ConsultNoteSections = {
  chiefComplaint: '',
  historyOfPresentIllness: '',
  assessment: '',
  plan: '',
  physicalExam: '',
};

/**
 * Calls Gemini to structure free-text clinical notes into C-CDA sections.
 * Falls back to placing all text in the assessment field if the API call fails.
 */
export async function structureNote(
  noteText: string,
  context: PatientContext,
): Promise<ConsultNoteSections> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[GeminiConsultNote] GEMINI_API_KEY not set — using fallback');
    return { ...FALLBACK_SECTIONS, assessment: noteText };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are a clinical documentation assistant. A specialist has written the following consultation note for patient ${context.firstName} ${context.lastName}. The reason for referral was: ${context.reasonForReferral || '(not specified)'}.

Clinical note text:
${noteText}

Structure this note into the following Consult Note C-CDA sections. Extract the relevant content from the note text and place it in the appropriate section. If a section has no relevant content, use an empty string.

Respond with a JSON object in this exact format:
{
  "chiefComplaint": "the chief complaint / reason for visit",
  "historyOfPresentIllness": "relevant history leading to this encounter",
  "assessment": "clinical assessment and findings",
  "plan": "treatment plan and follow-up recommendations",
  "physicalExam": "physical examination findings"
}

Return only the JSON object with no additional text.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Strip markdown code fences if Gemini wraps the response
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(json) as ConsultNoteSections;

    if (
      typeof parsed.chiefComplaint === 'string' &&
      typeof parsed.assessment === 'string' &&
      typeof parsed.plan === 'string'
    ) {
      return {
        chiefComplaint: parsed.chiefComplaint || '',
        historyOfPresentIllness: parsed.historyOfPresentIllness || '',
        assessment: parsed.assessment || '',
        plan: parsed.plan || '',
        physicalExam: parsed.physicalExam || '',
      };
    }

    console.warn('[GeminiConsultNote] Unexpected response shape — using fallback');
    return { ...FALLBACK_SECTIONS, assessment: noteText };
  } catch (err) {
    console.error('[GeminiConsultNote] structureNote failed:', err);
    return { ...FALLBACK_SECTIONS, assessment: noteText };
  }
}
