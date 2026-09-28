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
//   3. when the CSV supplied an EXPECTED_STATUS ("FIELD=VALUE"), that field
//      carries that exact value in the response, AND
//   4. when the CSV supplied an EXPECTED_MESSAGE, that text appears in the
//      response.
// Checks 3 and 4 are skipped (not failed) when the CSV left that column
// blank for a row - there is nothing to compare against.

def responseBody = prev.getResponseDataAsString() ?: ""
def httpOk = prev.isSuccessful()

def isFault = responseBody =~ /(?i)<[a-zA-Z0-9]*:?Fault[ >]/
def faultOk = !isFault

def expectedStatus = (vars.get("ExpectedStatus") ?: "").trim()
def statusOk = true
def statusDetail = ""
if (!expectedStatus.isEmpty()) {
    def parts = expectedStatus.split("=", 2)
    if (parts.length == 2) {
        def field = parts[0].trim()
        def expectedValue = parts[1].trim()
        // Lenient match against the shape X3's responses actually use -
        // <FLD NAME="field" ...>value</FLD> - without assuming the exact tag
        // name or attribute order, so small formatting differences between a
        // real gateway response and the CSV author's sample don't matter.
        def pattern = "(?is)NAME\\s*=\\s*\"" + java.util.regex.Pattern.quote(field) + "\"[^>]*>\\s*" +
                      java.util.regex.Pattern.quote(expectedValue) + "\\s*<"
        statusOk = (responseBody =~ pattern).find()
        if (!statusOk) {
            statusDetail = "expected " + field + "=" + expectedValue + " not found in response"
        }
    }
}

def expectedMessage = (vars.get("ExpectedMessage") ?: "").trim()
def messageOk = true
if (!expectedMessage.isEmpty()) {
    messageOk = responseBody.contains(expectedMessage)
}

def passFail = (httpOk && faultOk && statusOk && messageOk) ? "PASS" : "FAIL"

def errorParts = []
if (!httpOk) {
    if (prev.getResponseMessage()) errorParts << prev.getResponseMessage()
}
if (isFault) {
    def faultString = (responseBody =~ /(?is)<[a-zA-Z0-9]*:?faultstring[^>]*>(.*?)<\/[a-zA-Z0-9]*:?faultstring>/)
    errorParts << ("SOAP Fault" + (faultString.find() ? ": " + faultString.group(1).trim() : ""))
}
if (!statusOk) errorParts << statusDetail
if (!messageOk) errorParts << ("expected message not found: " + expectedMessage)

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
