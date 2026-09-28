// JSR223 Sampler used for a SOAP CSV row missing PUBLIC_NAME, REQUEST_XML or
// SOAP_ENDPOINT. Makes no network call - just records a SKIPPED sample so the
// row still appears in the results/.jtl and dashboard, mirroring
// scripts/SkipSampler.groovy in the REST flow.

def apiName = (vars.get("ServiceName") ?: "").trim()
if (apiName.isEmpty()) {
    apiName = (vars.get("PublicName") ?: "").trim()
}
if (apiName.isEmpty()) {
    apiName = "(unnamed SOAP row)"
}

SampleResult.setSampleLabel(apiName)
SampleResult.setResponseCode("SKIPPED")
SampleResult.setResponseMessage("Not executed - missing PUBLIC_NAME, REQUEST_XML or SOAP_ENDPOINT")
SampleResult.setSuccessful(true)
SampleResult.setResponseData("SKIPPED: row was missing a required column value", "UTF-8")
SampleResult.setDataType(org.apache.jmeter.samplers.SampleResult.TEXT)

vars.put("REC_METHOD", "")
vars.put("REC_URL", vars.get("SoapEndpoint"))
vars.put("REC_APINAME", apiName)
vars.put("REC_PASSFAIL", "SKIPPED")
vars.put("REC_ERROR", "")

log.info("SkipSoapSampler: " + apiName + " -> SKIPPED")
