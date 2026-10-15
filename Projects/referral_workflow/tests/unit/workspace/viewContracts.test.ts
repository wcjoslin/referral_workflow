/**
 * Contracts between the static views and the server, checked by reading the
 * view source. Neither `tsc` nor eslint looks inside an inline <script> in a
 * .html file, so a view can drift from the code it talks to with every other
 * gate green.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReferralState } from '../../../src/state/referralStateMachine';

const VIEWS = path.resolve(__dirname, '../../../src/views');
const read = (name: string): string => fs.readFileSync(path.join(VIEWS, name), 'utf8');

describe('queueView.html protocol-state filter', () => {
  it('offers exactly the real referral states', () => {
    // The server filters on the literal value, so a name that is not a real
    // state is silently dropped and the filter returns every row.
    const match = /var REFERRAL_STATES = \[([^\]]*)\]/.exec(read('queueView.html'));
    expect(match).not.toBeNull();
    const offered = match![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(offered.sort()).toEqual([...Object.values(ReferralState)].sort());
  });
});

describe('mobile viewport', () => {
  // ccdaFrame.html renders inside an iframe that sizes it, so it is exempt.
  const pages = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.html') && f !== 'ccdaFrame.html');

  it.each(pages)('%s declares a device-width viewport', (page) => {
    // Without it a phone lays the page out at desktop width and shrinks it.
    expect(read(page)).toMatch(/<meta name="viewport" content="width=device-width/);
  });
});
