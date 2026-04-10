/**
 * Unit tests for claudeService.ts (PRD-13 routing assessment).
 * Mocks @google/generative-ai and resourceCalendar to test classification,
 * post-processing, and fallback logic.
 */

jest.mock('@google/generative-ai');
jest.mock('../../../src/modules/prd03/resourceCalendar');

import { GoogleGenerativeAI } from '@google/generative-ai';
import { assessRouting, postProcessAssessment, RoutingAssessment } from '../../../src/modules/prd02/claudeService';
import { ExtendedReferralData } from '../../../src/modules/prd01/cdaParser';
import { getDepartments, getResources } from '../../../src/modules/prd03/resourceCalendar';

const MockedGoogleAI = GoogleGenerativeAI as jest.MockedClass<typeof GoogleGenerativeAI>;
const mockedGetDepartments = getDepartments as jest.MockedFunction<typeof getDepartments>;
const mockedGetResources = getResources as jest.MockedFunction<typeof getResources>;

// Minimal catalogue for tests
const TEST_DEPARTMENTS = ['Cardiology', 'General', 'Imaging'];
const TEST_RESOURCES = [
  { id: 'echo-lab', name: 'Echocardiography Lab', department: 'Cardiology', blockedSlots: [] },
  { id: 'stress-test-room', name: 'Cardiac Stress Test Room', department: 'Cardiology', blockedSlots: [] },
  { id: 'mri-suite', name: 'MRI Suite', department: 'Imaging', blockedSlots: [] },
  { id: 'exam-room-1', name: 'Exam Room 1', department: 'General', blockedSlots: [] },
];

const VALID_EXTENDED_DATA: ExtendedReferralData = {
  sourceMessageId: '<test-msg-001@hospital.direct>',
  patient: { firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1980-03-15' },
  reasonForReferral: 'Cardiology evaluation for recurring chest pain',
  isCdaValid: true,
  validationErrors: [],
  problems: ['Hypertension', 'Type 2 Diabetes'],
  allergies: ['Penicillin'],
  medications: ['Metformin 500mg', 'Lisinopril 10mg'],
  diagnosticResults: ['ECG: Normal sinus rhythm'],
  missingOptionalSections: [],
};

function mockGeminiResponse(body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
    generateContent: jest.fn().mockResolvedValue({
      response: { text: () => text },
    }),
  });
}

describe('assessRouting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
    mockedGetDepartments.mockReturnValue(TEST_DEPARTMENTS);
    mockedGetResources.mockReturnValue(TEST_RESOURCES);
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  describe('successful classification', () => {
    it('classifies a cardiology referral with correct department and equipment', async () => {
      mockGeminiResponse({
        department: 'Cardiology',
        departmentConfidence: 0.95,
        requiredEquipment: ['echo-lab'],
        summary: 'Patient requires cardiac evaluation for recurring chest pain.',
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.department).toBe('Cardiology');
      expect(result.departmentConfidence).toBe(0.95);
      expect(result.requiredEquipment).toHaveLength(1);
      expect(result.requiredEquipment[0].resourceId).toBe('echo-lab');
      expect(result.requiredEquipment[0].supported).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('returns summary text from Gemini', async () => {
      mockGeminiResponse({
        department: 'Cardiology',
        departmentConfidence: 0.9,
        requiredEquipment: [],
        summary: 'Chest pain evaluation needed.',
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.summary).toBe('Chest pain evaluation needed.');
    });

    it('strips markdown code fences from response', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockResolvedValue({
          response: {
            text: () =>
              '```json\n{"department":"Cardiology","departmentConfidence":0.8,"requiredEquipment":[],"summary":"Good."}\n```',
          },
        }),
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.department).toBe('Cardiology');
    });
  });

  describe('unknown department/equipment handling', () => {
    it('sets department to Unassigned when Gemini returns unknown department', async () => {
      mockGeminiResponse({
        department: 'Oncology',
        departmentConfidence: 0.85,
        requiredEquipment: [],
        summary: 'Cancer screening referral.',
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.department).toBe('Unassigned');
      expect(result.warnings).toContain("Department 'Oncology' not offered at this facility");
    });

    it('marks hallucinated equipment as unsupported', async () => {
      mockGeminiResponse({
        department: 'Cardiology',
        departmentConfidence: 0.9,
        requiredEquipment: ['echo-lab', 'pet-scanner'],
        summary: 'Cardiac evaluation.',
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.requiredEquipment).toHaveLength(2);
      const echoItem = result.requiredEquipment.find((e) => e.resourceId === 'echo-lab');
      expect(echoItem!.supported).toBe(true);
      const petItem = result.requiredEquipment.find((e) => e.resourceId === 'pet-scanner');
      expect(petItem!.supported).toBe(false);
      expect(result.warnings).toContain("Equipment 'pet-scanner' not found in facility catalogue");
    });
  });

  describe('fallback behavior', () => {
    it('returns Unassigned fallback when API key is not set', async () => {
      delete process.env.GEMINI_API_KEY;
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.department).toBe('Unassigned');
      expect(result.summary).toMatch(/unavailable/i);
    });

    it('returns Unassigned fallback when API throws', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockRejectedValue(new Error('API unavailable')),
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.department).toBe('Unassigned');
      expect(result.summary).toMatch(/unavailable/i);
    });

    it('returns Unassigned fallback when response JSON is malformed', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockResolvedValue({
          response: { text: () => 'not valid json{{{' },
        }),
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.department).toBe('Unassigned');
    });

    it('returns Unassigned fallback when response shape is unexpected', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockResolvedValue({
          response: { text: () => '{"foo": "bar"}' },
        }),
      });
      const result = await assessRouting(VALID_EXTENDED_DATA);
      expect(result.department).toBe('Unassigned');
      expect(result.summary).toMatch(/unavailable/i);
    });
  });
});

describe('postProcessAssessment', () => {
  beforeEach(() => {
    mockedGetDepartments.mockReturnValue(TEST_DEPARTMENTS);
    mockedGetResources.mockReturnValue(TEST_RESOURCES);
  });

  it('clamps confidence to 0-1 range', () => {
    const result = postProcessAssessment({
      department: 'Cardiology',
      departmentConfidence: 1.5,
      requiredEquipment: [],
      summary: 'Test.',
    });
    expect(result.departmentConfidence).toBe(1);
  });

  it('clamps negative confidence to 0', () => {
    const result = postProcessAssessment({
      department: 'Cardiology',
      departmentConfidence: -0.5,
      requiredEquipment: [],
      summary: 'Test.',
    });
    expect(result.departmentConfidence).toBe(0);
  });
});
