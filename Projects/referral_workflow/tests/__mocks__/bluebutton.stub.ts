/**
 * Stub for @kno2/bluebutton used by moduleNameMapper in jest.config.ts.
 *
 * This file replaces the actual browser-built webpack bundle so that its
 * side effects (requiring window/self/XMLSerializer) never execute in Node.
 *
 * Individual test files call jest.mock('@kno2/bluebutton') to get a
 * jest-managed mock of this stub, then control the return value per-test
 * with mockReturnValue / mockImplementation.
 */

import type { BlueButtonDocument } from '@kno2/bluebutton';

const BlueButton = jest.fn<BlueButtonDocument, [string]>();
export = BlueButton;
