/**
 * Regression tests for embedJson (src/util/htmlSafe.ts).
 *
 * These exist because the original code used `JSON.stringify` directly in every
 * page route, which let a patient name containing `</script>` close the script
 * element and inject HTML. Patient names come from inbound C-CDA documents, so
 * that was reachable with externally supplied data.
 *
 * The property under test is narrow and absolute: the output must be unable to
 * terminate a script element, and must still decode to the original value.
 */

import { embedJson } from '../../../src/util/htmlSafe';

/** The exact shape of the original vulnerability. */
const SCRIPT_BREAKOUT = '</script><img src=x onerror=alert(1)>';

describe('embedJson()', () => {
  describe('the breakout it exists to prevent', () => {
    it('emits no literal "</script>" for a value containing one', () => {
      const out = embedJson({ firstName: SCRIPT_BREAKOUT });

      expect(out).not.toContain('</script>');
      expect(out).not.toContain('<');
      expect(out).not.toContain('>');
    });

    it('leaves nothing that could close the element, however the value nests', () => {
      const nasty = {
        patient: { firstName: SCRIPT_BREAKOUT, lastName: 'O"Brien & <b>Sons</b>' },
        list: [SCRIPT_BREAKOUT, { deep: { deeper: ['</SCRIPT >', '</script\t>'] } }],
        'key-</script>': 'even in a key',
      };

      const out = embedJson(nasty);

      expect(out).not.toMatch(/<|>/);
    });

    it('escapes the three characters as unicode escapes', () => {
      expect(embedJson('<')).toBe('"\\u003c"');
      expect(embedJson('>')).toBe('"\\u003e"');
      expect(embedJson('&')).toBe('"\\u0026"');
    });

    it('is what JSON.stringify is not — the contrast, stated', () => {
      // Guards the reason this helper exists, so nobody "simplifies" it away.
      expect(JSON.stringify({ n: SCRIPT_BREAKOUT })).toContain('</script>');
      expect(embedJson({ n: SCRIPT_BREAKOUT })).not.toContain('</script>');
    });
  });

  describe('the value still arrives intact', () => {
    it('round-trips a hostile string byte for byte', () => {
      const value = { firstName: SCRIPT_BREAKOUT, lastName: 'O"Brien & <b>Sons</b>' };

      expect(JSON.parse(embedJson(value))).toEqual(value);
    });

    it('round-trips every JSON shape the payloads actually carry', () => {
      const value = {
        str: 'plain',
        num: 42,
        float: 1.5,
        neg: -7,
        bool: true,
        nil: null,
        arr: [1, 'two', false, null, { nested: true }],
        obj: { a: { b: { c: 'deep' } } },
        empty: {},
        emptyArr: [],
      };

      expect(JSON.parse(embedJson(value))).toEqual(value);
    });

    it('preserves characters that must not be mangled', () => {
      // Quotes, backslashes, newlines and non-ASCII all appear in real referral
      // data — the arrow in the state-machine error messages, for one.
      const value = {
        quote: 'say "hello"',
        backslash: 'C:\\path\\to\\file',
        newline: 'line one\nline two',
        tab: 'a\tb',
        arrow: 'Resolved \u2192 Triage',
        emoji: 'clinic \u{1F3E5}',
        accents: 'Rodr\u00EDguez',
      };

      expect(JSON.parse(embedJson(value))).toEqual(value);
    });

    it('handles the primitives and empties without special-casing', () => {
      expect(JSON.parse(embedJson(null))).toBeNull();
      expect(JSON.parse(embedJson(0))).toBe(0);
      expect(JSON.parse(embedJson(''))).toBe('');
      expect(JSON.parse(embedJson(false))).toBe(false);
      expect(JSON.parse(embedJson([]))).toEqual([]);
      expect(JSON.parse(embedJson({}))).toEqual({});
    });
  });

  describe('the output is valid JavaScript, not just valid JSON', () => {
    it('evaluates inside a script body to the original value', () => {
      const value = { firstName: SCRIPT_BREAKOUT, n: 1 };

      // Exactly how a page route uses it.
      const scriptBody = `window.__DATA__ = ${embedJson(value)};`;
      const sandbox: { __DATA__?: unknown } = {};
      new Function('window', scriptBody)(sandbox);

      expect(sandbox.__DATA__).toEqual(value);
    });
  });
});
