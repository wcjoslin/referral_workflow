/**
 * AI administrative routing assessment for PRD-02 / PRD-13.
 *
 * Uses Google Gemini (gemini-2.5-flash) to classify the receiving department,
 * identify required equipment, and produce a care-request summary for the
 * coordinator. This is advisory only — the result is shown in the UI but
 * never gates the workflow or auto-declines.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { ExtendedReferralData } from '../prd01/cdaParser';
import { getResources, getDepartments } from '../prd03/resourceCalendar';

export interface RoutingEquipmentItem {
  resourceId: string;
  name: string;
  supported: boolean;
}

export interface RoutingAssessment {
  department: string;
  departmentConfidence: number;
  requiredEquipment: RoutingEquipmentItem[];
  summary: string;
  warnings: string[];
}

const FALLBACK: RoutingAssessment = {
  department: 'Unassigned',
  departmentConfidence: 0,
  requiredEquipment: [],
  summary: 'Routing suggestion unavailable.',
  warnings: [],
};

/** Build the clinical context block sent to Gemini. */
function buildPromptContext(data: ExtendedReferralData): string {
  return [
    `Patient: ${data.patient.firstName} ${data.patient.lastName}, DOB: ${data.patient.dateOfBirth}`,
    `Reason for Referral: ${data.reasonForReferral || '(not provided)'}`,
    `Problems: ${data.problems.length > 0 ? data.problems.join(', ') : '(none listed)'}`,
    `Allergies: ${data.allergies.length > 0 ? data.allergies.join(', ') : '(none listed)'}`,
    `Medications: ${data.medications.length > 0 ? data.medications.join(', ') : '(none listed)'}`,
    `Diagnostic Results: ${data.diagnosticResults.length > 0 ? data.diagnosticResults.join(', ') : '(none listed)'}`,
  ].join('\n');
}

/** Build the facility catalogue section for the prompt. */
function buildFacilityContext(): string {
  const departments = getDepartments();
  const resources = getResources();

  const lines = ['Available Departments: ' + departments.join(', '), '', 'Equipment Catalogue:'];
  for (const r of resources) {
    lines.push(`  - ${r.id}: ${r.name} (Department: ${r.department})`);
  }
  return lines.join('\n');
}

interface GeminiRoutingResponse {
  department: string;
  departmentConfidence: number;
  requiredEquipment: string[];
  summary: string;
}

/**
 * Post-processes the raw Gemini response against the facility catalogue.
 * Marks unknown departments as "Unassigned" and unknown equipment as unsupported.
 */
export function postProcessAssessment(raw: GeminiRoutingResponse): RoutingAssessment {
  const departments = getDepartments();
  const resources = getResources();
  const resourceMap = new Map(resources.map((r) => [r.id, r]));

  const warnings: string[] = [];

  // Validate department
  let department = raw.department;
  if (!departments.includes(department)) {
    warnings.push(`Department '${department}' not offered at this facility`);
    department = 'Unassigned';
  }

  // Validate equipment
  const requiredEquipment: RoutingEquipmentItem[] = raw.requiredEquipment.map((id) => {
    const resource = resourceMap.get(id);
    if (resource) {
      return { resourceId: id, name: resource.name, supported: true };
    }
    warnings.push(`Equipment '${id}' not found in facility catalogue`);
    return { resourceId: id, name: id, supported: false };
  });

  return {
    department,
    departmentConfidence: Math.max(0, Math.min(1, raw.departmentConfidence)),
    requiredEquipment,
    summary: raw.summary,
    warnings,
  };
}

/**
 * Calls Gemini to produce a routing assessment for the referral.
 * Falls back to FALLBACK if the API call fails or returns an unexpected shape.
 */
export async function assessRouting(data: ExtendedReferralData): Promise<RoutingAssessment> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[ClaudeService] GEMINI_API_KEY not set — skipping routing assessment');
    return FALLBACK;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are an administrative referral routing assistant. A referral has been received with the following clinical information:

${buildPromptContext(data)}

The receiving facility has the following departments and equipment:

${buildFacilityContext()}

Based on the referral information, determine:
1. Which department should handle this referral (must be one of the available departments listed above)
2. Which equipment/resources from the catalogue will likely be needed (use the resource IDs)
3. A one or two sentence plain-language summary of what care is being requested

Respond with a JSON object in this exact format:
{
  "department": "department name from the list above",
  "departmentConfidence": 0.0 to 1.0,
  "requiredEquipment": ["resource-id-1", "resource-id-2"],
  "summary": "one or two sentence care request summary"
}

Return only the JSON object with no additional text.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Strip markdown code fences if Gemini wraps the response
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(json) as GeminiRoutingResponse;

    if (
      typeof parsed.department === 'string' &&
      typeof parsed.departmentConfidence === 'number' &&
      Array.isArray(parsed.requiredEquipment) &&
      typeof parsed.summary === 'string'
    ) {
      return postProcessAssessment(parsed);
    }

    console.warn('[ClaudeService] Unexpected response shape — using fallback');
    return FALLBACK;
  } catch (err) {
    console.error('[ClaudeService] assessRouting failed:', err);
    return FALLBACK;
  }
}
