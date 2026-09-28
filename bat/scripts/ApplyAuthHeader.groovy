// PreProcessor attached to the dynamic HTTP Request sampler, run immediately
// before it fires. Adds an Authorization header ONLY when one is actually
// needed for this row, so it never touches a CSV/flow that authenticates a
// different way (e.g. the Lewis Bakeries PWA, which logs in via a JSON POST
// body and has always run with Authorization blank on every row).
//
// Two sources, in order:
//   1. An AUTHORIZATION value the CSV itself supplies for this row (wired
//      through by the webapp's endpoint-schema normaliser, or present
//      directly in a HAR-style export) - used exactly as given, e.g.
//      "Bearer <token>" or a pre-built "Basic <base64>".
//   2. Otherwise, HTTP Basic Auth built from this run's own login
//      credentials - the standard, stateless authentication method for REST
//      APIs with no login/session step of their own (this is how Sage X3's
//      Web Service REST API authenticates every call). Only applied when the
//      webapp has explicitly flagged this run as needing that default
//      (USE_BASIC_AUTH_DEFAULT), so a HAR-style capture - which never sets
//      that flag - is completely unaffected.
import org.apache.jmeter.protocol.http.control.Header

def authValue = (vars.get("Authorization") ?: "").trim()
def authSource = authValue ? "CSV row" : null

// USE_BASIC_AUTH_DEFAULT is a process environment variable (like
// LOGIN_USERNAME/LOGIN_PASSWORD), not a JMeter variable - it is set once for
// the whole run by run_jmeter_test.bat, not per CSV row.
if (!authValue && System.getenv("USE_BASIC_AUTH_DEFAULT") == "true") {
    // This thread's own login (scripts\AssignLoginUser.groovy, multi-user
    // runs) wins; otherwise the run-wide login, exactly as before.
    def username = vars.get("LOGIN_USERNAME") ?: System.getenv("LOGIN_USERNAME") ?: props.get("LOGIN_USERNAME")
    def password = vars.get("LOGIN_PASSWORD") ?: System.getenv("LOGIN_PASSWORD") ?: props.get("LOGIN_PASSWORD")
    if (username && password) {
        String creds = username + ":" + password
        authValue = "Basic " + creds.getBytes("UTF-8").encodeBase64().toString()
        authSource = "Basic Auth default (login credentials)"
    }
}

if (authValue) {
    def headerManager = sampler.getHeaderManager()
    if (headerManager != null) {
        headerManager.removeHeaderNamed("Authorization")
        headerManager.add(new Header("Authorization", authValue))
        // Logs which scheme/source was used, never the credential value itself
        // (which for Basic Auth is trivially reversible base64) - this file can
        // be shared far more casually than the masked prompts credentials go
        // through elsewhere in this project.
        def scheme = authValue.contains(" ") ? authValue.split(" ")[0] : "(unknown scheme)"
        log.info("ApplyAuthHeader: added '${scheme}' Authorization header from ${authSource} for " + vars.get("Method") + " " + vars.get("Path"))
    }
} else {
    log.info("ApplyAuthHeader: no Authorization header applied for " + vars.get("Method") + " " + vars.get("Path"))
}
