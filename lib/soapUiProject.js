import { serialiseCsv } from './csvSchema.js';

/**
 * Reads a SoapUI project XML (e.g. csv files\Route_SOAP.xml) and returns its
 * test-step requests as the SOAP CSV layout lib/soapCsvSchema.js already
 * accepts, held in memory only - no CSV file is read or written for it. That
 * keeps the XML the sole source of services and request bodies while the
 * normaliser, run directory, .jmx and report stay exactly as they were.
 *
 * Only `request` test steps are taken (the interface's own operation templates
 * hold "?" placeholders and are not runnable). Per step: the step name is the
 * service name, <publicName> in the envelope is the public name, the step's
 * endpoint and request envelope are used as written, and SOAP_ACTION comes
 * from the matching WSDL operation. SoapUI's "SOAP Response" assertion carries
 * no expected status/message, so those columns are left empty. The project's
 * own HTTP credentials are ignored - the login saved under Configuration is
 * what authenticates a run, as for every other SOAP source.
 */

const HEADER = [
  'SERVICE_NAME',
  'PUBLIC_NAME',
  'SOAP_ENDPOINT',
  'SOAP_ACTION',
  'REQUEST_XML',
  'EXPECTED_STATUS',
  'EXPECTED_MESSAGE',
];

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
const decode = (s) => s.replace(/&(?:lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m]);

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/**
 * The text of the element whose content starts at `from`, up to `closeTag`.
 * CDATA sections are taken literally and joined to the text around them, which
 * is how SoapUI stores an envelope that itself holds a <![CDATA[...]]> (the
 * inner "]]>" is written "]]]]>><![CDATA[").
 */
function readElementText(xml, from, closeTag) {
  let out = '';
  let i = from;
  while (i < xml.length) {
    if (xml.startsWith(CDATA_OPEN, i)) {
      const end = xml.indexOf(CDATA_CLOSE, i + CDATA_OPEN.length);
      if (end < 0) return null;
      out += xml.slice(i + CDATA_OPEN.length, end);
      i = end + CDATA_CLOSE.length;
    } else if (xml.startsWith(closeTag, i)) {
      return out;
    } else {
      const next = xml.indexOf('<', i + 1);
      const stop = next < 0 ? xml.length : next;
      out += decode(xml.slice(i, stop));
      i = stop;
    }
  }
  return null;
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : '';
};

/** WSDL operation name -> SOAPAction, from the interface's <con:operation>s. */
function operationActions(xml) {
  const actions = new Map();
  for (const m of xml.matchAll(/<con:operation\s[^>]*>/g)) {
    const name = attr(m[0], 'name');
    if (name) actions.set(name, attr(m[0], 'action'));
  }
  return actions;
}

/**
 * Returns { ok, csv, stepCount } or { ok: false, message }.
 */
export function soapUiProjectToCsv(xml) {
  if (!/<con:soapui-project[\s>]/.test(xml)) {
    return { ok: false, message: 'This is not a SoapUI project XML (no <con:soapui-project> element).' };
  }

  const actions = operationActions(xml);
  const rows = [HEADER];

  for (const m of xml.matchAll(/<con:testStep\s[^>]*>[\s\S]*?<\/con:testStep>/g)) {
    const step = m[0];
    const openTag = step.slice(0, step.indexOf('>') + 1);
    if (attr(openTag, 'type') !== 'request' || attr(openTag, 'disabled') === 'true') continue;

    const name = attr(openTag, 'name');
    const endpoint = /<con:endpoint>([^<]*)<\/con:endpoint>/.exec(step)?.[1]?.trim() ?? '';
    const operation = /<con:operation>([^<]*)<\/con:operation>/.exec(step)?.[1]?.trim() ?? '';

    // The envelope is the attribute-less <con:request>; the one carrying a
    // name/id wraps the whole request definition.
    const bodyStart = step.indexOf('<con:request>');
    const body = bodyStart < 0 ? null : readElementText(step, bodyStart + '<con:request>'.length, '</con:request>');
    if (body === null) continue;

    const publicName = /<publicName[^>]*>([^<]*)<\/publicName>/.exec(body)?.[1]?.trim() ?? '';
    rows.push([name, publicName, decode(endpoint), actions.get(operation) ?? '', body.trim(), '', '']);
  }

  if (rows.length < 2) {
    return { ok: false, message: 'The SoapUI project contains no runnable request test steps.' };
  }
  return { ok: true, csv: serialiseCsv(rows), stepCount: rows.length - 1 };
}
