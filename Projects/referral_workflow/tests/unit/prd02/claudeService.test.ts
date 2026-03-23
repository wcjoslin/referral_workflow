/**
 * Unit tests for claudeService.ts
 * Mocks @google/generative-ai to test transformation and fallback logic.
 */

jest.mock('@google/generative-ai');
import { GoogleGenerativeAI } from '@google/generative-ai';
import { assessSufficiency, SufficiencyAssessment } from '../../../src/modules/prd02/claudeService';
import { ExtendedReferralData } from '../../../src/modules/prd01/cdaParser';

const MockedGoogleAI = GoogleGenerativeAI as jest.MockedClass<typeof GoogleGenerativeAI>;

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

function mockSuccessResponse(assessment: SufficiencyAssessment): void {
  MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
    generateContent: jest.fn().mockResolvedValue({
      response: { text: () => JSON.stringify(assessment) },
    }),
  });
}

describe('assessSufficiency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  describe('successful API response', () => {
    it('returns sufficient: true when Gemini says so', async () => {
      mockSuccessResponse({ sufficient: true, summary: 'Referral is complete.', concerns: [] });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.sufficient).toBe(true);
    });

    it('returns the summary from Gemini', async () => {
      mockSuccessResponse({ sufficient: true, summary: 'All required information is present.', concerns: [] });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.summary).toBe('All required information is present.');
    });

    it('returns concerns array from Gemini', async () => {
      mockSuccessResponse({
        sufficient: false,
        summary: 'Missing diagnostic context.',
        concerns: ['No recent lab results', 'Chief complaint lacks specificity'],
      });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.concerns).toHaveLength(2);
      expect(result.concerns[0]).toMatch(/lab results/i);
    });

    it('returns sufficient: false when Gemini flags concerns', async () => {
      mockSuccessResponse({ sufficient: false, summary: 'Incomplete.', concerns: ['Missing labs'] });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.sufficient).toBe(false);
    });

    it('strips markdown code fences from response', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockResolvedValue({
          response: {
            text: () => '```json\n{"sufficient":true,"summary":"Good.","concerns":[]}\n```',
          },
        }),
      });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.sufficient).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('returns fallback when API key is not set', async () => {
      delete process.env.GEMINI_API_KEY;
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.sufficient).toBe(true);
      expect(result.summary).toMatch(/unavailable/i);
    });

    it('returns fallback when API throws', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockRejectedValue(new Error('API unavailable')),
      });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.sufficient).toBe(true);
      expect(result.summary).toMatch(/unavailable/i);
    });

    it('returns fallback when response JSON is malformed', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockResolvedValue({
          response: { text: () => 'not valid json{{{' },
        }),
      });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.sufficient).toBe(true);
    });

    it('returns fallback when response shape is unexpected', async () => {
      MockedGoogleAI.prototype.getGenerativeModel = jest.fn().mockReturnValue({
        generateContent: jest.fn().mockResolvedValue({
          response: { text: () => '{"foo": "bar"}' },
        }),
      });
      const result = await assessSufficiency(VALID_EXTENDED_DATA);
      expect(result.sufficient).toBe(true);
      expect(result.summary).toMatch(/unavailable/i);
    });
  });
});
