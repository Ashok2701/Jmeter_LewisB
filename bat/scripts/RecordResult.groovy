// PostProcessor attached to the dynamic HTTP Request sampler.
// Exposes extra columns (method/url/name/pass-fail/error) as JMeter
// variables so they can be appended to the .jtl via the
// sample_variables JMeter property (see run command in README/notes).

def passFail = prev.isSuccessful() ? "PASS" : "FAIL"

String errorInfo = ""
if (!prev.isSuccessful()) {
    def parts = []
    if (prev.getResponseMessage()) parts << prev.getResponseMessage()
    if (prev.getFirstAssertionFailureMessage()) parts << prev.getFirstAssertionFailureMessage()
    errorInfo = parts.join(" | ")
}

// ---- Response body for the report's Statistics "Response" column ----
// Only the first response per API + status code is recorded (props is shared
// by every thread), so the .jtl holds a handful of bodies rather than one per
// sample. scripts\Write-ReportSampleInfo.ps1 turns them into the report.
// Identical in RecordSoapResult.groovy and ValidateSqlResult.groovy.
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

vars.put("REC_METHOD", vars.get("Method"))
vars.put("REC_URL", vars.get("URL"))
vars.put("REC_APINAME", vars.get("Method") + " " + vars.get("Path"))
vars.put("REC_PASSFAIL", passFail)
vars.put("REC_ERROR", errorInfo)

log.info("RecordResult: " + vars.get("Method") + " " + vars.get("Path") +
          " -> " + prev.getResponseCode() + " (" + passFail + ") in " + prev.getTime() + "ms")
