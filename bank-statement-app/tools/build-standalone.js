'use strict';

/**
 * Builds bank-statement-tool.html: the whole app in one file that runs by
 * double-clicking it, with no install, no server and no network.
 *
 * Everything is assembled from the same sources the server uses, so the two
 * cannot drift:
 *   - core logic       src/{account-utils,csv,transform,responses,xlsx-browser}.js
 *   - account list     data/bank-accounts.json
 *   - markup           public/index.html (the header and main elements)
 *   - styles           public/styles.css
 *   - controller       public/app.js
 *   - data access      public/api-local.js (in place of api-http.js)
 *
 * Run `npm run build:standalone` after changing any of them. A test fails if
 * the committed file is stale.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'bank-statement-tool.html');

/** Core modules, in dependency order. Keys are the require() names used. */
const CORE_MODULES = [
  ['account-utils', 'src/account-utils.js'],
  ['csv', 'src/csv.js'],
  ['transform', 'src/transform.js'],
  ['xlsx-browser', 'src/xlsx-browser.js'],
  ['responses', 'src/responses.js'],
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Guards against a `</script>` inside embedded JS or JSON ending the block. */
function safeForScriptTag(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

/**
 * Wraps the CommonJS core modules in a tiny registry, so their unmodified
 * require()/module.exports keep working in the browser.
 */
function bundleCore() {
  const accounts = JSON.parse(read('data/bank-accounts.json'));

  const defines = CORE_MODULES.map(([name, file]) => {
    const source = read(file);
    return (
      `  registry[${JSON.stringify(name)}] = function (module, exports, require) {\n` +
      `${indent(source, 4)}\n` +
      '  };'
    );
  }).join('\n\n');

  return `var BankStatementCore = (function () {
  'use strict';
  var registry = {};
  var cache = {};

  function require(name) {
    var key = String(name).replace(/^\\.\\//, '');
    if (cache[key]) return cache[key].exports;
    if (!registry[key]) throw new Error('Unknown module: ' + name);
    var module = { exports: {} };
    cache[key] = module;
    registry[key](module, module.exports, require);
    return module.exports;
  }

${defines}

  return {
    accounts: ${safeForScriptTag(JSON.stringify(accounts, null, 2))},
    accountUtils: require('account-utils'),
    csv: require('csv'),
    transform: require('transform'),
    xlsx: require('xlsx-browser'),
    responses: require('responses')
  };
})();`;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

/** Pulls the page body out of the served index.html so markup is not duplicated. */
function extractMarkup() {
  const html = read('public/index.html');
  const start = html.indexOf('<header class="masthead">');
  const end = html.indexOf('</main>');
  if (start === -1 || end === -1) {
    throw new Error('public/index.html no longer has the expected header/main structure.');
  }
  return html.slice(start, end + '</main>'.length).trim();
}

function build() {
  const markup = extractMarkup();
  const styles = read('public/styles.css').trim();
  const core = bundleCore();
  const apiLocal = safeForScriptTag(read('public/api-local.js').trim());
  const controller = safeForScriptTag(read('public/app.js').trim());
  const favicon = read('public/favicon.svg').trim();
  const faviconDataUri = `data:image/svg+xml;base64,${Buffer.from(favicon).toString('base64')}`;

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bank Statement Generator — D365 Import</title>
    <link rel="icon" href="${faviconDataUri}" type="image/svg+xml" />
    <!--
      GENERATED FILE — do not edit by hand.
      Built by tools/build-standalone.js from the sources listed in its header.
      Rebuild with: npm run build:standalone

      Everything runs in your browser. No server, no install, no network: the
      CSV you choose is never uploaded anywhere, and the Excel file is written
      locally by your browser.
    -->
    <style>
${indent(styles, 6)}
    </style>
  </head>
  <body>
    ${markup.split('\n').join('\n    ')}

    <script>
${indent(core, 6)}
    </script>
    <script>
${indent(apiLocal, 6)}
    </script>
    <script>
${indent(controller, 6)}
    </script>
  </body>
</html>
`;

  return html;
}

if (require.main === module) {
  const html = build();
  fs.writeFileSync(OUTPUT, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${kb} KB)`);
}

module.exports = { build, OUTPUT };
