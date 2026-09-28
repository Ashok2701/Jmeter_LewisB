// JSR223 Sampler for SQL CSV rows that are not executed (Enabled=false).
// Makes no database call - just records a SKIPPED sample so the row still
// appears in the .jtl and the report, like SkipSampler.groovy does for REST.

def testName = (vars.get("TestName") ?: "").trim()
def reason = vars.get("SKIP_REASON") ?: "Not enabled"

SampleResult.setSampleLabel("SQL " + (testName ?: "(unnamed row)") + " (SKIPPED)")
SampleResult.setResponseCode("SKIPPED")
SampleResult.setResponseMessage("Not executed - " + reason)
SampleResult.setSuccessful(true)
SampleResult.setResponseData("SKIPPED: " + reason, "UTF-8")
SampleResult.setDataType(org.apache.jmeter.samplers.SampleResult.TEXT)

vars.put("REC_METHOD", "SQL")
vars.put("REC_URL", "")
vars.put("REC_APINAME", testName)
vars.put("REC_PASSFAIL", "SKIPPED")
vars.put("REC_ERROR", "")

log.info("SkipSqlSampler: " + testName + " -> SKIPPED (" + reason + ")")
