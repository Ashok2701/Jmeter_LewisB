// Runs as its own JSR223 Sampler (not a PreProcessor), for the same reason as
// scripts/PrepareRequest.groovy in the REST flow: it must unconditionally run
// at the start of every iteration, before the If Controllers decide which
// branch to enter, so EXECUTE_FLAG/SKIP_FLAG are always fresh. Makes no
// network call.
//
// Unlike the REST flow, a SOAP CSV row's REQUEST_XML is already a complete,
// ready-to-send envelope (publicName, callContext, credentials and all
// business parameters already inlined by whoever built the CSV) - so there is
// no template substitution to do here. This script only has to:
//   1. decide whether the row has enough to execute at all, and
//   2. split SoapEndpoint into the domain/port/path/protocol the
//      HTTPSamplerProxy needs, the same way PrepareRequest.groovy does for
//      the REST flow's URL column.
import java.net.URI

// The previous API's response body (REC_RESPONSE, see RecordSoapResult.groovy)
// must not carry into this iteration's Prepare or Skip sample rows.
vars.put("REC_RESPONSE", "")

def apiName = (vars.get("ServiceName") ?: "").trim()
if (apiName.isEmpty()) {
    apiName = (vars.get("PublicName") ?: "").trim()
}

def publicName = (vars.get("PublicName") ?: "").trim()

// The label the HTTP sampler (and its SKIPPED twin) carries in the report:
// the public name, plus the CSV's SERVICE_NAME when that says something
// different. JMeter reports one line per label, so rows sharing a public name
// (e.g. Sales Order's XSOHCRE1 called once per customer) would otherwise merge
// into a single line. Unchanged when SERVICE_NAME is empty or equal.
def serviceName = (vars.get("ServiceName") ?: "").trim()
vars.put("v_label", (serviceName.isEmpty() || serviceName == publicName) ? publicName : publicName + " - " + serviceName)

def requestXml = vars.get("RequestXml")
def endpoint = (vars.get("SoapEndpoint") ?: "").trim()

boolean execute = !publicName.isEmpty() && requestXml != null && !requestXml.trim().isEmpty() && !endpoint.isEmpty()
vars.put("EXECUTE_FLAG", execute as String)
vars.put("SKIP_FLAG", (!execute) as String)

SampleResult.setSampleLabel("Prepare - " + (apiName.isEmpty() ? "(unnamed SOAP row)" : apiName))
SampleResult.setDataType(org.apache.jmeter.samplers.SampleResult.TEXT)

if (!execute) {
    vars.put("v_protocol", "")
    vars.put("v_server", "")
    vars.put("v_port", "")
    vars.put("v_path", "")
    vars.put("v_soapaction", "\"\"")
    SampleResult.setResponseCode("N/A")
    SampleResult.setSuccessful(true)
    SampleResult.setResponseData("Missing PUBLIC_NAME, REQUEST_XML or SOAP_ENDPOINT for this row - routed to skip branch.", "UTF-8")
    log.info("PrepareSoapRequest: skipping (" + apiName + ") - missing required column value in CSV row")
    return
}

try {
    URI uri = new URI(endpoint)
    vars.put("v_protocol", uri.getScheme())
    vars.put("v_server", uri.getHost())
    int port = uri.getPort()
    vars.put("v_port", port == -1 ? "" : port as String)
    String path = uri.getRawPath()
    if (uri.getRawQuery()) {
        path = path + "?" + uri.getRawQuery()
    }
    vars.put("v_path", path)
} catch (Exception e) {
    log.error("PrepareSoapRequest: could not parse SOAP_ENDPOINT for (" + apiName + ") (" + endpoint + ") - " + e.getMessage())
    vars.put("EXECUTE_FLAG", "false")
    vars.put("SKIP_FLAG", "true")
    SampleResult.setResponseCode("ERROR")
    SampleResult.setSuccessful(false)
    SampleResult.setResponseData("Could not parse SOAP_ENDPOINT: " + endpoint + " - " + e.getMessage(), "UTF-8")
    return
}

// SOAP 1.1 allows (and some gateways require) an empty SOAPAction header -
// "" is the spec-correct way to say "no specific action", rather than
// omitting the header. Any quotes the CSV itself already wrapped the value in
// are stripped first so they are never doubled.
def rawAction = (vars.get("SoapAction") ?: "").trim()
if (rawAction.startsWith('"') && rawAction.endsWith('"') && rawAction.length() >= 2) {
    rawAction = rawAction.substring(1, rawAction.length() - 1)
}
vars.put("v_soapaction", "\"" + rawAction + "\"")

SampleResult.setResponseCode("200")
SampleResult.setSuccessful(true)
SampleResult.setResponseData("Prepared SOAP call " + publicName + " -> " + endpoint, "UTF-8")
