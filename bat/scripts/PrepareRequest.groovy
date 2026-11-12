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

// {USER_CODE:<role>} in the URL (workbook APIs, see lib\userCodes.js) is filled
// in here with THIS thread's own code of that role, in the order of the role's
// sheet: thread 1 = the sheet's code 1, thread 2 = code 2, ... Nothing is random,
// so a run always uses the same users (lib\rolePlan.js buildThreadPlan lists the
// same assignment for the Test Running popup). A plain, unsplit run with more
// threads than codes wraps round; a split run is rejected before that can happen.
// The codes come from USER_CODES_CSV (ROLE,CODE rows, written per run by the
// webapp). Only the request URL is changed; the sample label (Path) keeps the
// placeholder, so every thread reports under the one API.
String codeError = ""
if (url.contains("USER_CODE:") ) {
    def codesByRole = null
    synchronized (props) {
        codesByRole = props.get("USER_CODES_BY_ROLE")
        if (codesByRole == null) {
            codesByRole = [:]
            def csvPath = System.getenv("USER_CODES_CSV") ?: props.get("USER_CODES_CSV")
            def csvFile = csvPath ? new File(csvPath as String) : null
            if (csvFile != null && csvFile.isFile()) {
                csvFile.withReader("UTF-8") { reader ->
                    def buffered = new BufferedReader(reader)
                    org.apache.jmeter.save.CSVSaveService.csvReadFile(buffered, (char) ',') // header
                    while (buffered.ready()) {
                        def row = org.apache.jmeter.save.CSVSaveService.csvReadFile(buffered, (char) ',')
                        if (row != null && row.length >= 2 && row[0] && row[1]) {
                            codesByRole.get(row[0], []) << row[1]
                        }
                    }
                }
            } else {
                log.warn("PrepareRequest: USER_CODES_CSV is not set or not found - {USER_CODE:...} cannot be filled in")
            }
            props.put("USER_CODES_BY_ROLE", codesByRole)
        }
    }
    def token = ~/(?i)(?:\{|%7B)USER_CODE:([a-z0-9_]+)(?:\}|%7D)/
    url = url.replaceAll(token) { whole, role ->
        def codes = codesByRole[role.toLowerCase()]
        if (!codes) {
            codeError = "No user codes for role '" + role + "'"
            return whole
        }
        String code = codes[ctx.getThreadNum() % codes.size()]
        return java.net.URLEncoder.encode(code, "UTF-8").replace("+", "%20")
    }
}

// ---- Pagination (Merchandiser REST runs only) -------------------------------
// PAGINATION_MODE (env, set by the webapp for Merchandiser REST runs) is "all":
// every API is paged, PAGINATION_PAGE_SIZE records (1000) per page, until the API
// has no more records - there is no page or record limit. Unset (every other
// run) leaves this iteration exactly as it always was: one request, and
// scripts\Paginate.groovy ends the page loop straight away.
// This sets up the PER-THREAD pagination state of the API about to run, so
// every thread (user) pages on its own - nothing here is shared between threads.
// The per-API settings (PAGINATION_CONFIG_CSV, one row per API path) can switch an
// API off (PAGINATION = No) or give it another mechanism: PAGE_TYPE
// (link = Sage "$links.$next", page, offset) and the parameter names for the
// page / offset types. Only the page size (count=...) of the first request is
// changed; every other parameter is left exactly as the API list has it.
vars.put("PAGE_MORE", "true")
vars.put("PAGE_NO", "1")
vars.put("PAGE_MODE", "off")
vars.put("REC_PAGING", "")
String runPagingMode = (System.getenv("PAGINATION_MODE") ?: "").trim().toLowerCase()
if (runPagingMode == "all") {
    def pagingByPath = null
    synchronized (props) {
        pagingByPath = props.get("PAGINATION_BY_PATH")
        if (pagingByPath == null) {
            pagingByPath = [:]
            def cfgPath = System.getenv("PAGINATION_CONFIG_CSV")
            def cfgFile = cfgPath ? new File(cfgPath as String) : null
            if (cfgFile != null && cfgFile.isFile()) {
                cfgFile.withReader("UTF-8") { reader ->
                    def buffered = new BufferedReader(reader)
                    org.apache.jmeter.save.CSVSaveService.csvReadFile(buffered, (char) ',') // header
                    while (buffered.ready()) {
                        def r = org.apache.jmeter.save.CSVSaveService.csvReadFile(buffered, (char) ',')
                        if (r != null && r.length >= 5 && r[0]) {
                            pagingByPath.put(r[0], [pagination: r[1], type: r[2], pageParam: r[3], sizeParam: r[4]])
                        }
                    }
                }
            }
            props.put("PAGINATION_BY_PATH", pagingByPath)
        }
    }
    def apiCfg = pagingByPath.get(vars.get("Path") ?: "") ?: [:]

    // Per-thread counter: (thread name, sequence) identifies one API's run of pages in the JTL.
    int seq = ((vars.get("PAGE_SEQ_N") ?: "0") as int) + 1
    vars.put("PAGE_SEQ_N", String.valueOf(seq))
    vars.put("PAGE_SEQ", String.valueOf(seq))
    vars.putObject("PAGE_SEEN", new HashSet<String>())
    vars.put("PAGE_LAST_HASH", "")
    vars.put("PAGE_TOTAL", "0")

    String type = (apiCfg.type ?: "link").toLowerCase()
    String sizeText = System.getenv("PAGINATION_PAGE_SIZE") ?: "1000"
    vars.put("PAGE_TYPE", type)

    // param(url, name) -> current value or null; setParam(url, name, value) -> url with it set.
    def param = { String u, String n ->
        def m = (u =~ ("(?<=[?&])" + java.util.regex.Pattern.quote(n) + "=([^&]*)"))
        return m.find() ? m.group(1) : null
    }
    def setParam = { String u, String n, String v ->
        def m = (u =~ ("(?<=[?&])" + java.util.regex.Pattern.quote(n) + "=[^&]*"))
        if (m.find()) return u.substring(0, m.start()) + n + "=" + v + u.substring(m.end())
        return u + (u.contains("?") ? "&" : "?") + n + "=" + v
    }

    if (!"no".equals(apiCfg.pagination) && !url.isEmpty()) {
        vars.put("PAGE_MODE", runPagingMode)
        if (type == "page" || type == "offset") {
            String pageParam = apiCfg.pageParam ?: (type == "page" ? "page" : "offset")
            String sizeParam = apiCfg.sizeParam ?: (type == "page" ? "pageSize" : "limit")
            vars.put("PAGE_PARAM", pageParam)
            vars.put("SIZE_PARAM", sizeParam)
            if (sizeText) url = setParam(url, sizeParam, sizeText)
            String have = param(url, sizeParam)
            vars.put("PAGE_SIZE_N", have ?: "0")
            vars.put("PAGE_COUNT", have ?: "")
            String start = param(url, pageParam)
            if (start == null) { start = (type == "page") ? "1" : "0"; url = setParam(url, pageParam, start) }
            vars.put("PAGE_START", start)
            vars.put("PAGE_BASE_URL", url)
        } else {
            if (sizeText) url = setParam(url, "count", sizeText)
            String have = param(url, "count")
            vars.put("PAGE_SIZE_N", have ?: "0")
            vars.put("PAGE_COUNT", have ?: "")
        }
    } else {
        vars.put("PAGE_SIZE_N", "0")
        vars.put("PAGE_COUNT", "")
    }
}

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

if (codeError) {
    log.error("PrepareRequest: (" + apiName + ") - " + codeError)
    vars.put("EXECUTE_FLAG", "false")
    vars.put("SKIP_FLAG", "true")
    vars.put("RESOLVED_BODY", "")
    SampleResult.setResponseCode("ERROR")
    SampleResult.setSuccessful(false)
    SampleResult.setResponseData(codeError + " - check the role sheet in the workbook.", "UTF-8")
    return
}

try {
    URI uri = new URI(url.replace(" ", "%20"))
    vars.put("v_protocol", uri.getScheme())
    vars.put("v_server", uri.getHost())
    int port = uri.getPort()
    vars.put("v_port", port == -1 ? "" : port as String)
    String path = uri.getRawPath()
    if (uri.getRawQuery()) {
        path = path + "?" + uri.getRawQuery()
    }
    vars.put("v_path", path)
    // Pagination only follows links on the host the first page was requested from.
    vars.put("PAGE_ORIGIN", uri.getScheme().toLowerCase() + "://" + uri.getHost().toLowerCase() + ":" +
        (port == -1 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : port))
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
