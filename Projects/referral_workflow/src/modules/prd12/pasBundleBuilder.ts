/**
 * PRD-12 PAS Bundle Builder
 *
 * Constructs a Da Vinci PAS-compliant FHIR Bundle from referral + patient + form data.
 * Pure function — no side effects, no DB access. All data passed in as typed input.
 *
 * Bundle structure (per PAS IG):
 *   1. Claim (first entry, use: "preauthorization")
 *   2. Patient
 *   3. Coverage
 *   4. Practitioner (requesting provider)
 *   5. Organization (insurer)
 *   6. Condition(s) (supporting info from referral clinical data)
 */

import { randomUUID } from 'crypto';

// ── Input Interfaces ──────────────────────────────────────────────────────────

export interface PriorAuthFormData {
  patientFirstName: string;
  patientLastName: string;
  patientDob: string; // YYYY-MM-DD
  patientGender?: string;
  insurerName: string;
  insurerId: string;
  subscriberId?: string;
  serviceCode: string; // CPT/HCPCS
  serviceDisplay?: string;
  providerNpi: string;
  providerName: string;
  diagnoses?: Array<{ code: string; display: string }>;
}

// ── FHIR Resource Types ───────────────────────────────────────────────────────

export interface FhirResource {
  resourceType: string;
  id: string;
  [key: string]: unknown;
}

export interface FhirBundleEntry {
  fullUrl: string;
  resource: FhirResource;
}

export interface PasBundle {
  resourceType: 'Bundle';
  id: string;
  type: 'collection';
  timestamp: string;
  entry: FhirBundleEntry[];
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildPasBundle(data: PriorAuthFormData): PasBundle {
  const patientUuid = randomUUID();
  const practitionerUuid = randomUUID();
  const insurerUuid = randomUUID();
  const coverageUuid = randomUUID();
  const claimUuid = randomUUID();

  const conditionEntries: FhirBundleEntry[] = (data.diagnoses ?? []).map((dx) => {
    const uuid = randomUUID();
    return {
      fullUrl: `urn:uuid:${uuid}`,
      resource: {
        resourceType: 'Condition',
        id: uuid,
        subject: { reference: `urn:uuid:${patientUuid}` },
        code: {
          coding: [
            {
              system: 'http://hl7.org/fhir/sid/icd-10-cm',
              code: dx.code,
              display: dx.display,
            },
          ],
          text: dx.display,
        },
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
        },
      },
    };
  });

  const supportingInfo = conditionEntries.map((entry, idx) => ({
    sequence: idx + 1,
    category: {
      coding: [
        {
          system: 'http://hl7.org/fhir/us/davinci-pas/CodeSystem/PASSupportingInfoType',
          code: 'patientDiagnosis',
        },
      ],
    },
    valueReference: { reference: entry.fullUrl },
  }));

  const diagnosisEntries = conditionEntries.map((entry, idx) => ({
    sequence: idx + 1,
    diagnosisReference: { reference: entry.fullUrl },
  }));

  const claim: FhirResource = {
    resourceType: 'Claim',
    id: claimUuid,
    status: 'active',
    use: 'preauthorization',
    type: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/claim-type',
          code: 'professional',
          display: 'Professional',
        },
      ],
    },
    patient: { reference: `urn:uuid:${patientUuid}` },
    created: new Date().toISOString().substring(0, 10),
    insurer: { reference: `urn:uuid:${insurerUuid}` },
    provider: { reference: `urn:uuid:${practitionerUuid}` },
    priority: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }],
    },
    insurance: [
      {
        sequence: 1,
        focal: true,
        coverage: { reference: `urn:uuid:${coverageUuid}` },
      },
    ],
    diagnosis: diagnosisEntries.length > 0 ? diagnosisEntries : undefined,
    supportingInfo: supportingInfo.length > 0 ? supportingInfo : undefined,
    item: [
      {
        sequence: 1,
        productOrService: {
          coding: [
            {
              system: 'http://www.ama-assn.org/go/cpt',
              code: data.serviceCode,
              display: data.serviceDisplay ?? data.serviceCode,
            },
          ],
        },
        servicedDate: new Date().toISOString().substring(0, 10),
        diagnosisSequence: diagnosisEntries.length > 0 ? diagnosisEntries.map((_, i) => i + 1) : undefined,
      },
    ],
  };

  const patient: FhirResource = {
    resourceType: 'Patient',
    id: patientUuid,
    name: [
      {
        family: data.patientLastName,
        given: [data.patientFirstName],
      },
    ],
    birthDate: data.patientDob,
    gender: data.patientGender ?? 'unknown',
  };

  const coverage: FhirResource = {
    resourceType: 'Coverage',
    id: coverageUuid,
    status: 'active',
    subscriber: { reference: `urn:uuid:${patientUuid}` },
    beneficiary: { reference: `urn:uuid:${patientUuid}` },
    payor: [{ reference: `urn:uuid:${insurerUuid}` }],
    subscriberId: data.subscriberId ?? undefined,
  };

  const practitioner: FhirResource = {
    resourceType: 'Practitioner',
    id: practitionerUuid,
    identifier: [
      {
        system: 'http://hl7.org/fhir/sid/us-npi',
        value: data.providerNpi,
      },
    ],
    name: [{ text: data.providerName }],
  };

  const insurer: FhirResource = {
    resourceType: 'Organization',
    id: insurerUuid,
    identifier: [
      {
        system: 'http://hl7.org/fhir/sid/us-npi',
        value: data.insurerId,
      },
    ],
    name: data.insurerName,
  };

  return {
    resourceType: 'Bundle',
    id: randomUUID(),
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: `urn:uuid:${claimUuid}`, resource: claim },
      { fullUrl: `urn:uuid:${patientUuid}`, resource: patient },
      { fullUrl: `urn:uuid:${coverageUuid}`, resource: coverage },
      { fullUrl: `urn:uuid:${practitionerUuid}`, resource: practitioner },
      { fullUrl: `urn:uuid:${insurerUuid}`, resource: insurer },
      ...conditionEntries,
    ],
  };
}

/**
 * Extracts the Claim resource from a PAS Bundle.
 */
export function extractClaim(bundle: PasBundle): FhirResource | null {
  const entry = bundle.entry.find((e) => e.resource.resourceType === 'Claim');
  return entry?.resource ?? null;
}
