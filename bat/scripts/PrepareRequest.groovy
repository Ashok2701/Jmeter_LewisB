// Runs as its own JSR223 Sampler (not a PreProcessor) so it unconditionally
// executes at the start of every iteration, before the If Controllers decide
// which branch to enter. A loose PreProcessor placed as a plain sibling of
// the If Controllers only fires once a Sampler inside one of those branches
// actually runs - but the If Controller evaluates its condition beforehand,
// so it would always see last iteration's (or an empty) EXECUTE_FLAG. Making
// this a real, unconditional Sampler guarantees the variables are fresh by
// the time the If Controllers are evaluated. It makes no network call.
import java.net.URI
import groovy.json.JsonSlurper
import groovy.json.JsonOutput

// The previous API's response body (REC_RESPONSE, see RecordResult.groovy) must
// not carry into this iteration's Prepare or Skip sample rows.
vars.put("REC_RESPONSE", "")

def apiName = (vars.get("Method") ?: "") + " " + (vars.get("Path") ?: vars.get("URL"))
def method = (vars.get("Method") ?: "").trim()
def url = (vars.get("URL") ?: "").trim()
def bodyTemplate = vars.get("Request_Body")

boolean execute = !method.isEmpty() && !url.isEmpty()
vars.put("EXECUTE_FLAG", execute as String)
vars.put("SKIP_FLAG", (!execute) as String)

SampleResult.setSampleLabel("Prepare - " + apiName)
SampleResult.setDataType(org.apache.jmeter.samplers.SampleResult.TEXT)

if (!execute) {
    vars.put("v_protocol", "")
    vars.put("v_server", "")
    vars.put("v_port", "")
    vars.put("v_path", "")
    vars.put("RESOLVED_BODY", "")
    SampleResult.setResponseCode("N/A")
    SampleResult.setSuccessful(true)
    SampleResult.setResponseData("No HTTP_Method for this row - routed to skip branch.", "UTF-8")
    log.info("PrepareRequest: skipping (" + apiName + ") - no Method/URL in CSV row")
    return
}

try {
    URI uri = new URI(url)
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
    log.error("PrepareRequest: could not parse URL for (" + apiName + ") (" + url + ") - " + e.getMessage())
    vars.put("EXECUTE_FLAG", "false")
    vars.put("SKIP_FLAG", "true")
    vars.put("RESOLVED_BODY", "")
    SampleResult.setResponseCode("ERROR")
    SampleResult.setSuccessful(false)
    SampleResult.setResponseData("Could not parse URL: " + url + " - " + e.getMessage(), "UTF-8")
    return
}

String resolvedBody = ""
if (bodyTemplate != null && !bodyTemplate.trim().isEmpty()) {
    try {
        def json = new JsonSlurper().parseText(bodyTemplate)

        // The HAR showed dateTime is a client-generated "now" timestamp on every
        // call (3 captured calls to the same endpoints each carried a different
        // value) - regenerate it so replays don't resend a stale captured time.
        if (json instanceof Map && json.containsKey("dateTime")) {
            json.dateTime = new Date().format("yyyy-MM-dd HH:mm:ss")
        }

        // Login placeholders are never stored in the CSV; substitute real
        // credentials only at run time, never from a file. Environment
        // variables are checked first because JMeter echoes every -J
        // property (including its value) to the console and jmeter.log -
        // the env var path is what run_jmeter_test.bat uses to avoid that
        // leak. Falls back to the -JLOGIN_USERNAME/-JLOGIN_PASSWORD JMeter
        // properties for direct/manual jmeter invocations. This thread's own
        // login (scripts\AssignLoginUser.groovy, multi-user runs) is checked
        // before either.
        if (json instanceof Map && json.containsKey("username") && json.username == "<USERNAME>") {
            json.username = vars.get("LOGIN_USERNAME") ?: System.getenv("LOGIN_USERNAME") ?: (props.get("LOGIN_USERNAME") ?: "<USERNAME>")
        }
        if (json instanceof Map && json.containsKey("password") && json.password == "<PASSWORD>") {
            json.password = vars.get("LOGIN_PASSWORD") ?: System.getenv("LOGIN_PASSWORD") ?: (props.get("LOGIN_PASSWORD") ?: "<PASSWORD>")
        }

        resolvedBody = JsonOutput.toJson(json)
    } catch (Exception e) {
        resolvedBody = bodyTemplate
        log.warn("PrepareRequest: Request_Body for " + apiName + " is not valid JSON, sending as-is. " + e.getMessage())
    }
}
vars.put("RESOLVED_BODY", resolvedBody)

SampleResult.setResponseCode("200")
SampleResult.setSuccessful(true)
SampleResult.setResponseData("Prepared " + vars.get("Method") + " " + url, "UTF-8")
