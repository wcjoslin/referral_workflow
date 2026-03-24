/**
 * Mock EHR trigger for the PRD-04 happy-path demo.
 *
 * Fires non-blocking after a referral encounter is marked complete (from encounterService).
 * Generates sample clinical note text and calls consultNoteService.generateAndSend().
 *
 * In production this would be replaced by an inbound ORU^R01 listener
 * connected to the EHR system.
 */

import { generateAndSend } from './consultNoteService';

const SAMPLE_CONSULT_NOTE = `
Patient was referred for cardiology evaluation due to exertional chest pain and dyspnea.

Chief Complaint: Exertional chest pain and shortness of breath with activity for the past 3 months.

History of Present Illness:
The patient is a 44-year-old with a history of essential hypertension, hyperlipidemia, and type 2 diabetes mellitus who presents for cardiology consultation. She reports progressive chest tightness and dyspnea on exertion over the past 3 months, occurring with moderate activity such as climbing stairs or brisk walking. Symptoms resolve with rest within 5-10 minutes. She denies chest pain at rest, palpitations, syncope, or peripheral edema. Her current medications include lisinopril 20mg daily, metformin 1000mg BID, atorvastatin 40mg daily, and aspirin 81mg daily.

Physical Examination:
Vitals: BP 138/88 mmHg, HR 78 bpm, RR 16, O2 Sat 98% on room air, BMI 31.2
General: Well-appearing, no acute distress
Cardiovascular: Regular rate and rhythm, no murmurs, rubs, or gallops. JVP normal. No peripheral edema.
Pulmonary: Clear to auscultation bilaterally, no wheezes or crackles.

Assessment:
1. Exertional angina — likely stable angina given predictable onset with exertion and relief with rest. Risk factors include hypertension, hyperlipidemia, diabetes, and obesity.
2. Echocardiogram shows preserved EF of 55% with mild diastolic dysfunction (Grade I). No significant valvular disease.
3. Stress echocardiogram demonstrates mild anteroseptal wall motion abnormality at peak stress, suggestive of ischemia in the LAD territory.
4. Lipid panel shows LDL 142 mg/dL despite atorvastatin — suboptimal control.

Plan:
1. Refer for cardiac catheterization to evaluate coronary anatomy given positive stress test.
2. Intensify lipid management — increase atorvastatin to 80mg daily, target LDL < 70 mg/dL.
3. Optimize blood pressure control — increase lisinopril to 40mg daily, target BP < 130/80.
4. Add long-acting nitrate (isosorbide mononitrate 30mg daily) for angina prophylaxis.
5. Cardiac rehabilitation referral after catheterization results available.
6. Follow-up in 2 weeks for catheterization results and medication titration.
7. Patient counseled on lifestyle modifications including dietary changes and gradual exercise program.
`.trim();

/**
 * Called (non-blocking) after a referral encounter is marked complete.
 */
export async function onEncounterComplete(referralId: number): Promise<void> {
  await generateAndSend({
    referralId,
    noteText: SAMPLE_CONSULT_NOTE,
  });

  console.log(`[MockEHR] Auto-generated and sent consult note for referral #${referralId}`);
}
