// PostProcessor attached to the dynamic SOAP HTTP Request sampler. Exposes
// the same REC_* variables the REST flow's RecordResult.groovy does, so this
// flow's .jtl carries a comparable set of extra columns (see sample_variables
// in run_soap_test.bat) and both flows can share the same webapp summary code.
//
// A SOAP gateway like Sage X3's CAdxWebServiceXmlCC almost always answers
// with HTTP 200 even for a business-level failure - the failure shows up
// inside the response body, not as an HTTP status. So "Passed" here means
// more than "the HTTP call succeeded":
//   1. the HTTP request itself succeeded, AND
//   2. the response is not a SOAP Fault, AND
//   3. when the CSV supplied an EXPECTED_STATUS (one or more "FIELD=VALUE"
//      pairs separated by ";"), every non-I_ field carries that value in the
//      response, AND
//   4. when the CSV supplied an EXPECTED_MESSAGE, that text appears in the
//      response's message field (digit-bearing words are wildcards).
// Checks 3 and 4 are skipped (not failed) when the CSV left that column
// blank for a row - there is nothing to compare against.

def responseBody = prev.getResponseDataAsString() ?: ""
def httpOk = prev.isSuccessful()

// A 200 with no body, or a body that is not well-formed XML (e.g. an HTML
// error page from a proxy), is not a usable SOAP reply. Only judged when the
// HTTP call itself succeeded - otherwise JMeter's own error already says why.
def bodyPresentOk = !httpOk || !responseBody.trim().isEmpty()
def wellFormedOk = true
def wellFormedDetail = ""
if (httpOk && bodyPresentOk) {
    try {
        def dbf = javax.xml.parsers.DocumentBuilderFactory.newInstance()
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        dbf.setNamespaceAware(true)
        def builder = dbf.newDocumentBuilder()
        builder.setErrorHandler(null)
        def doc = builder.parse(new org.xml.sax.InputSource(new java.io.StringReader(responseBody.trim())))
        def rootName = doc.getDocumentElement().getLocalName() ?: doc.getDocumentElement().getNodeName()
        if (rootName != "Envelope") {
            wellFormedOk = false
            wellFormedDetail = "Response is not a SOAP envelope (root element <" + rootName + ">)"
        }
    } catch (Exception e) {
        wellFormedOk = false
        wellFormedDetail = "Malformed SOAP response (not valid XML): " + (e.getMessage() ?: e.getClass().getSimpleName()).replaceAll(/\s+/, " ").trim()
    }
}

def isFault = responseBody =~ /(?i)<[a-zA-Z0-9]*:?Fault[ >]/
def faultOk = !isFault

// Sage X3 also answers HTTP 200 with no Fault when it cannot run the web
// service: the reply then carries an error CAdxMessage (<type>3</type>) and
// no resultXml. That is a failed call, whatever the CSV expects.
def sageMsg = (responseBody =~ /(?is)<type>3<\/type>\s*<message>(.*?)<\/message>/)
def sageErrorOk = !sageMsg.find()
def sageErrorText = sageErrorOk ? "" : "Sage error: " + sageMsg.group(1).trim()

// Values of every <FLD NAME="field" ...>value</FLD> in the response (a field
// inside a table appears once per line). Lenient about tag/attribute order so
// small formatting differences between a real gateway response and the CSV
// author's sample don't matter; a self-closing <FLD .../> counts as "".
def fieldValues = { String field ->
    def found = []
    def m = responseBody =~ ("(?is)<FLD\\b[^>]*?NAME\\s*=\\s*\"" + java.util.regex.Pattern.quote(field) + "\"[^>]*?(?:/>|>(.*?)</FLD>)")
    while (m.find()) found << (m.group(1) ?: "").trim()
    return found
}

// EXPECTED_STATUS holds one or more "FIELD=VALUE" pairs separated by ";",
// each validated on its own. The expectation decides what success means for
// the service, so any other actual value (e.g. O_XFLG=0 or 1 when 2 is
// expected) fails. I_ fields are the request echoed back, not a result, so
// they are not validated.
def expectedStatus = (vars.get("ExpectedStatus") ?: "").trim()
def statusErrors = []
expectedStatus.split(";").each { String part ->
    def kv = part.trim().split("=", 2)
    if (kv.length != 2) return
    def field = kv[0].trim()
    def expectedValue = kv[1].trim()
    if (field.isEmpty() || field.toUpperCase().startsWith("I_")) return
    def actual = fieldValues(field)
    if (actual.isEmpty()) {
        statusErrors << ("output field " + field + " missing from response (expected " + expectedValue + ")")
    } else if (!actual.contains(expectedValue)) {
        statusErrors << (field + " expected " + expectedValue + " but got " + actual.unique().join("/"))
    }
}
def statusOk = statusErrors.isEmpty()
def statusDetail = statusErrors.join(" | ")

// Message text is compared case/whitespace-insensitively, with any word that
// contains a digit (document numbers, dates, ids) treated as a wildcard, so
// "Credit memo No.: SCM000124 created successfully." still matches a later
// run's SCM000187. Wording changes still fail. Checked against the response's
// O_ message field(s); if the response has none, against the whole body.
def normaliseText = { String s ->
    s.replaceAll(/\s+/, " ").trim().toLowerCase().split(" ").collect { it =~ /\d/ ? "#" : it }.join(" ")
}
def expectedMessage = (vars.get("ExpectedMessage") ?: "").trim()
def messageOk = true
def actualMessages = []
if (!expectedMessage.isEmpty()) {
    def nameMatcher = responseBody =~ /(?is)<FLD\b[^>]*?NAME\s*=\s*"(O_\w*(?:MESS|MSG)\w*)"/
    def messageFields = [] as LinkedHashSet
    while (nameMatcher.find()) messageFields << nameMatcher.group(1)
    messageFields.each { actualMessages.addAll(fieldValues(it).findAll { v -> !v.isEmpty() }) }
    def wanted = normaliseText(expectedMessage)
    def haystacks = actualMessages.isEmpty() ? [responseBody] : actualMessages
    messageOk = haystacks.any { normaliseText(it).contains(wanted) }
}

def passFail = (httpOk && bodyPresentOk && wellFormedOk && faultOk && sageErrorOk && statusOk && messageOk) ? "PASS" : "FAIL"

def errorParts = []
if (!httpOk) {
    if (prev.getResponseMessage()) errorParts << prev.getResponseMessage()
}
if (!bodyPresentOk) errorParts << "Empty response body"
if (!wellFormedOk) errorParts << wellFormedDetail
if (isFault) {
    def faultString = (responseBody =~ /(?is)<[a-zA-Z0-9]*:?faultstring[^>]*>(.*?)<\/[a-zA-Z0-9]*:?faultstring>/)
    errorParts << ("SOAP Fault" + (faultString.find() ? ": " + faultString.group(1).trim() : ""))
}
if (!sageErrorOk) errorParts << sageErrorText
if (!statusOk) errorParts << statusDetail
if (!messageOk) {
    errorParts << ("expected message not found: " + expectedMessage +
                   (actualMessages.isEmpty() ? "" : " (response message: " + actualMessages.unique().join(" / ") + ")"))
}

// Make the sample itself fail, so JTL success and the report's Passed/Failed
// counts agree with REC_PASSFAIL (as ValidateSqlResult.groovy does).
if (passFail == "FAIL") {
    prev.setSuccessful(false)
    // An HTTP 200 that fails here carries no JMeter assertion, so without one
    // the dashboard can only say a generic "Assertion failed". Attaching the
    // reason as an assertion result puts it in the .jtl failureMessage column,
    // which the Errors and Top 5 Errors by sampler tables then show.
    if (httpOk) {
        def failureResult = new org.apache.jmeter.assertions.AssertionResult("SOAP response check")
        failureResult.setFailure(true)
        failureResult.setFailureMessage(errorParts.join(" | "))
        prev.addAssertionResult(failureResult)
    }
}

def apiName = (vars.get("ServiceName") ?: "").trim()
if (apiName.isEmpty()) {
    apiName = (vars.get("PublicName") ?: "").trim()
}

// ---- Response body for the report's Statistics "Response" column ----
// Only the first response per API + status code is recorded (props is shared
// by every thread), so the .jtl holds a handful of bodies rather than one per
// sample. scripts\Write-ReportSampleInfo.ps1 turns them into the report.
// Identical in RecordResult.groovy and ValidateSqlResult.groovy.
final int MAX_RESPONSE_CHARS = 5000000
String respCaptured = ""
if (props.putIfAbsent("RESP_CAPTURED|" + prev.getSampleLabel() + "|" + prev.getResponseCode(), "1") == null) {
    if (org.apache.jmeter.samplers.SampleResult.BINARY == prev.getDataType()) {
        respCaptured = "[Binary response: " + (prev.getContentType() ?: "unknown content type") + ", " + prev.getBytesAsLong() + " bytes - not displayed]"
    } else {
        respCaptured = prev.getResponseDataAsString() ?: ""
        int respTotal = respCaptured.length()
        if (respTotal > MAX_RESPONSE_CHARS) {
            respCaptured = respCaptured.substring(0, MAX_RESPONSE_CHARS) +
                "\n[Response truncated: the first " + MAX_RESPONSE_CHARS + " of " + respTotal + " characters are shown]"
        }
    }
}
vars.put("REC_RESPONSE", respCaptured)

vars.put("REC_METHOD", "POST")
vars.put("REC_URL", vars.get("SoapEndpoint"))
vars.put("REC_APINAME", apiName)
vars.put("REC_PASSFAIL", passFail)
vars.put("REC_ERROR", errorParts.join(" | "))

log.info("RecordSoapResult: " + apiName + " -> " + prev.getResponseCode() + " (" + passFail + ") in " + prev.getTime() + "ms")
if (passFail == "FAIL") {
    log.warn("RecordSoapResult FAIL reason: " + errorParts.join(" | ") +
             " [ExpectedStatus='" + expectedStatus + "' ExpectedMessage='" + expectedMessage + "']")
    log.warn("RecordSoapResult FAIL response body: " + responseBody)
}
