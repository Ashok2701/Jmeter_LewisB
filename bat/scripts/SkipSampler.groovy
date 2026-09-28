// JSR223 Sampler used for CSV rows with no HTTP_Method (i.e. APIs marked
// NOT_FOUND_IN_HAR). Makes no network call - just records a SKIPPED
// sample so the row still appears in the results/.jtl and dashboard.

def apiName = (vars.get("Method") ?: "") + " " + (vars.get("Path") ?: vars.get("URL"))
def notes = vars.get("Notes") ?: "Excluded - not captured/verified in the HAR"

SampleResult.setSampleLabel(apiName)
SampleResult.setResponseCode("SKIPPED")
SampleResult.setResponseMessage("Not executed - " + notes)
SampleResult.setSuccessful(true)
SampleResult.setResponseData("SKIPPED: " + notes, "UTF-8")
SampleResult.setDataType(org.apache.jmeter.samplers.SampleResult.TEXT)

vars.put("REC_METHOD", "")
vars.put("REC_URL", vars.get("URL"))
vars.put("REC_APINAME", apiName)
vars.put("REC_PASSFAIL", "SKIPPED")
vars.put("REC_ERROR", "")

log.info("SkipSampler: " + apiName + " -> SKIPPED (" + notes + ")")
