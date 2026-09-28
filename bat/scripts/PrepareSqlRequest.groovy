// SQL counterpart of PrepareRequest.groovy. Runs as its own JSR223 Sampler at
// the start of every iteration of sql_test.jmx, so the If Controllers that
// follow always see this row's flags. Makes no database call; its
// "Prepare - SQL ..." sample is filtered out of the report by
// scripts\report-generator.properties.
//
// Reads the current CSV row (TestName,Query,Parameters,ExpectedRows,Enabled,
// Description) and sets:
//   EXECUTE_FLAG / SKIP_FLAG   which branch runs (JDBC Request or SKIPPED)
//   SKIP_REASON                why a row is skipped
//   SQL_PARAM_VALUES           the JDBC Request's "Parameter values"
//   SQL_PARAM_TYPES            the JDBC Request's "Parameter types"
//
// Parameters use "Key=Value" segments separated by "|", e.g.
// "Customer=C001|Status=2". Only the values are bound, in order, to the
// query's "?" placeholders; the key names document what each one is. Values
// are bound as VARCHAR - SQL Server converts them for numeric/date columns.

def testName = (vars.get("TestName") ?: "").trim()
def query = (vars.get("Query") ?: "").trim()
def enabled = (vars.get("Enabled") ?: "").trim().toLowerCase()
def parametersRaw = (vars.get("Parameters") ?: "").trim()

SampleResult.setSampleLabel("Prepare - SQL " + (testName ?: "(unnamed row)"))
SampleResult.setDataType(org.apache.jmeter.samplers.SampleResult.TEXT)

// The JDBC Request only sets SQL_RESULT when it succeeds, so clear the
// previous row's result - ValidateSqlResult.groovy must never count the
// rows of an earlier query.
vars.remove("SQL_RESULT")

// The previous query's response (REC_RESPONSE, see ValidateSqlResult.groovy)
// must not carry into this iteration's Prepare or Skip sample rows.
vars.put("REC_RESPONSE", "")

String skipReason = ""
if (!testName || !query) {
    skipReason = "Row has no TestName or Query"
} else if (enabled != "true") {
    skipReason = "Enabled=" + (vars.get("Enabled") ?: "")
}

def values = []
if (parametersRaw) {
    parametersRaw.split("\\|").each { segment ->
        def trimmed = segment.trim()
        if (trimmed) {
            int eq = trimmed.indexOf("=")
            values << (eq >= 0 ? trimmed.substring(eq + 1) : trimmed).trim()
        }
    }
}

// JMeter splits "Parameter values" as CSV, so each value is quoted (with any
// quote inside it doubled) - a value containing a comma stays one value.
vars.put("SQL_PARAM_VALUES", values.collect { '"' + it.replace('"', '""') + '"' }.join(","))
vars.put("SQL_PARAM_TYPES", values.collect { "VARCHAR" }.join(","))

boolean execute = skipReason.isEmpty()
vars.put("EXECUTE_FLAG", execute as String)
vars.put("SKIP_FLAG", (!execute) as String)
vars.put("SKIP_REASON", skipReason)

SampleResult.setResponseCode("200")
SampleResult.setSuccessful(true)
SampleResult.setResponseData(
    execute ? "Prepared SQL " + testName + " with " + values.size() + " parameter(s)"
            : "Skipping SQL " + testName + " - " + skipReason,
    "UTF-8")

log.info("PrepareSqlRequest: " + testName + " -> " + (execute ? "execute" : "skip (" + skipReason + ")"))
