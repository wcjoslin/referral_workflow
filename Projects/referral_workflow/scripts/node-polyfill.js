// Polyfills required by browser-built webpack bundles (e.g. @kno2/bluebutton)
// running in a Node.js environment. Must be loaded before those packages.

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

global.self = global;
global.window = global;
global.DOMParser = DOMParser;
global.XMLSerializer = XMLSerializer;
