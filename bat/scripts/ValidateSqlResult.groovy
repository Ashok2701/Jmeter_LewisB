// JSR223 PostProcessor on sql_test.jmx's JDBC Request - the SQL counterpart
// of RecordResult.groovy / RecordSoapResult.groovy.
//
// PASS: the query ran and, when ExpectedRows is given, returned exactly that
//       many rows.
// FAIL: the query raised a SQL error (connection, login, syntax... - the JDBC
//       Request has already marked the sample failed with the driver's
//       message), or returned a different number of rows than ExpectedRows.
//
// A failed query never stops the run: the Thread Group continues on sample
// error, so the next CSV row runs as normal.
//
// Also exposes the REC_* columns appended to the .jtl via sample_variables,
// exactly like the REST/SOAP flows.

import org.apache.jmeter.assertions.AssertionResult

def testName = vars.get("TestName") ?: ""
def expectedRaw = (vars.get("ExpectedRows") ?: "").trim()
String errorInfo = ""

if (prev.isSuccessful()) {
    def result = vars.getObject("SQL_RESULT")
    int actualRows = (result instanceof Collection) ? result.size() : 0

    if (expectedRaw) {
        int expectedRows = expectedRaw as int
        if (actualRows != expectedRows) {
            errorInfo = "Expected " + expectedRows + " row(s) but the query returned " + actualRows
            // Recorded as an assertion failure, so the .jtl's failureMessage
            // column and the report's Errors table carry the reason.
            def check = new AssertionResult("ExpectedRows")
            check.setFailure(true)
            check.setFailureMessage(errorInfo)
            prev.addAssertionResult(check)
            prev.setSuccessful(false)
        } else {
            prev.setResponseMessage("OK - " + actualRows + " row(s), as expected")
        }
    } else {
        prev.setResponseMessage("OK - " + actualRows + " row(s) returned")
    }
} else {
    errorInfo = prev.getResponseMessage() ?: "SQL execution failed"
    // The JDBC Request records "<SQLState> <error number>". A connection or
    // login failure raised before SQL Server answered has no SQLState, which
    // would read "null 0" in the report.
    if ((prev.getResponseCode() ?: "").startsWith("null")) {
        prev.setResponseCode("SQL ERROR")
    }
}

def passFail = prev.isSuccessful() ? "PASS" : "FAIL"

// ---- Response for the report's Statistics "Response" column ----
// For a query this is the result set JMeter's JDBC Request returned. Only the
// first response per query + result code is recorded (props is shared by every
// thread), so the .jtl holds a handful rather than one per sample.
// scripts\Write-ReportSampleInfo.ps1 turns them into the report.
// Identical in RecordResult.groovy and RecordSoapResult.groovy.
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

vars.put("REC_METHOD", "SQL")
vars.put("REC_URL", "")
vars.put("REC_APINAME", testName)
vars.put("REC_PASSFAIL", passFail)
vars.put("REC_ERROR", errorInfo)

log.info("ValidateSqlResult: " + testName + " -> " + prev.getResponseCode() + " (" + passFail + ") in " +
         prev.getTime() + "ms" + (errorInfo ? " - " + errorInfo : ""))
