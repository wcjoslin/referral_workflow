/**
 * Unit tests for cdaParser.ts
 *
 * @kno2/bluebutton is mocked here — unit tests cover parseCda's transformation
 * and validation logic, not BlueButton's internal XML parsing.
 *
 * Mock shape matches BlueButton 0.6.x runtime output:
 *   - demographics is a FLAT object (name, dob strings) — NOT entries-based
 *   - chief_complaint.text may be plain or XML-wrapped (stripXmlTags handles both)
 */
import { parseCda } from '../../src/modules/prd01/cdaParser';

jest.mock('@kno2/bluebutton');
import BlueButton from '@kno2/bluebutton';
const mockBlueButton = BlueButton as jest.MockedFunction<typeof BlueButton>;

const TEST_MESSAGE_ID = '<test-message-001@referral.direct>';

/** Returns a BlueButton document matching the actual 0.6.x runtime shape */
function makeValidDoc(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ccda',
    source: {},
    data: {
      demographics: {
        name: { given: ['Jane'], family: 'Doe', prefix: null },
        dob: '1980-03-15T08:00:00.000Z',  // ISO string as returned by BlueButton 0.6.x
        gender: 'female',
        marital_status: null,
        address: { street: [], city: null, state: null, zip: null, country: null },
        phone: { home: null, work: null, mobile: null },
        email: null,
      },
      chief_complaint: {
        text: 'Patient referred for cardiology evaluation due to recurring chest pain.',
      },
      ...overrides,
    },
  };
}

describe('parseCda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path — valid C-CDA', () => {
    beforeEach(() => {
      mockBlueButton.mockReturnValue(makeValidDoc() as unknown as ReturnType<typeof BlueButton>);
    });

    it('extracts patient first name', () => {
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.patient.firstName).toBe('Jane');
    });

    it('extracts patient last name', () => {
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.patient.lastName).toBe('Doe');
    });

    it('extracts date of birth in ISO 8601 format', () => {
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.patient.dateOfBirth).toBe('1980-03-15');
    });

    it('strips XML tags from chief_complaint text', () => {
      mockBlueButton.mockReturnValue(
        makeValidDoc({
          chief_complaint: {
            text: '<text xmlns="urn:hl7-org:v3">Patient referred for cardiology evaluation due to recurring chest pain.</text>',
          },
        }) as unknown as ReturnType<typeof BlueButton>,
      );
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.reasonForReferral).toContain('cardiology evaluation');
      expect(result.reasonForReferral).not.toContain('<text');
    });

    it('extracts reason for referral from chief_complaint section', () => {
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.reasonForReferral).toContain('cardiology evaluation');
    });

    it('sets isCdaValid to true when all required fields are present', () => {
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.isCdaValid).toBe(true);
    });

    it('returns no validation errors for a valid document', () => {
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.validationErrors).toHaveLength(0);
    });

    it('returns the sourceMessageId passed in', () => {
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.sourceMessageId).toBe(TEST_MESSAGE_ID);
    });
  });

  describe('error handling — BlueButton throws', () => {
    it('sets isCdaValid to false when BlueButton throws', () => {
      mockBlueButton.mockImplementation(() => {
        throw new Error('Failed to serialize XML node');
      });
      const result = parseCda('<bad/>', TEST_MESSAGE_ID);
      expect(result.isCdaValid).toBe(false);
    });

    it('includes the error message in validationErrors', () => {
      mockBlueButton.mockImplementation(() => {
        throw new Error('Failed to serialize XML node');
      });
      const result = parseCda('<bad/>', TEST_MESSAGE_ID);
      expect(result.validationErrors[0]).toMatch(/Failed to serialize XML node/);
    });

    it('returns empty patient fields when BlueButton throws', () => {
      mockBlueButton.mockImplementation(() => {
        throw new Error('parse error');
      });
      const result = parseCda('<bad/>', TEST_MESSAGE_ID);
      expect(result.patient.firstName).toBe('');
      expect(result.patient.lastName).toBe('');
      expect(result.patient.dateOfBirth).toBe('');
    });
  });

  describe('error handling — missing required fields', () => {
    it('sets isCdaValid to false when first name is missing', () => {
      mockBlueButton.mockReturnValue(
        makeValidDoc({
          demographics: {
            name: { given: [], family: 'Doe' },
            dob: '1980-03-15T08:00:00.000Z',
          },
        }) as unknown as ReturnType<typeof BlueButton>,
      );
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.isCdaValid).toBe(false);
      expect(result.validationErrors.some((e) => /first name/i.test(e))).toBe(true);
    });

    it('sets isCdaValid to false when last name is missing', () => {
      mockBlueButton.mockReturnValue(
        makeValidDoc({
          demographics: {
            name: { given: ['Jane'], family: '' },
            dob: '1980-03-15T08:00:00.000Z',
          },
        }) as unknown as ReturnType<typeof BlueButton>,
      );
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.isCdaValid).toBe(false);
      expect(result.validationErrors.some((e) => /last name/i.test(e))).toBe(true);
    });

    it('sets isCdaValid to false when DOB is missing', () => {
      mockBlueButton.mockReturnValue(
        makeValidDoc({
          demographics: {
            name: { given: ['Jane'], family: 'Doe' },
            dob: null,
          },
        }) as unknown as ReturnType<typeof BlueButton>,
      );
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.isCdaValid).toBe(false);
      expect(result.validationErrors.some((e) => /date of birth/i.test(e))).toBe(true);
    });

    it('sets isCdaValid to false when chief_complaint text is missing', () => {
      mockBlueButton.mockReturnValue(
        makeValidDoc({ chief_complaint: { text: '' } }) as unknown as ReturnType<typeof BlueButton>,
      );
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.isCdaValid).toBe(false);
      expect(result.validationErrors.some((e) => /reason for referral/i.test(e))).toBe(true);
    });
  });

  describe('date formatting', () => {
    it('formats a valid ISO date string as YYYY-MM-DD', () => {
      mockBlueButton.mockReturnValue(
        makeValidDoc({
          demographics: {
            name: { given: ['Jane'], family: 'Doe' },
            dob: '1995-07-04T07:00:00.000Z',
          },
        }) as unknown as ReturnType<typeof BlueButton>,
      );
      const result = parseCda('<xml/>', TEST_MESSAGE_ID);
      expect(result.patient.dateOfBirth).toBe('1995-07-04');
    });
  });
});
