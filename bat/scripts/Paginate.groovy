// PostProcessor on the API's HTTP Request sampler, inside the "Pagination loop"
// While Controller (condition ${PAGE_MORE}). It runs after EVERY page request,
// reads that page's response and decides whether another page is requested:
//
//   - sets PAGE_MORE to "true" and points the sampler at the next page
//     (v_protocol / v_server / v_port / v_path), or sets it to "false" to end the loop;
//   - writes REC_PAGING = "<sequence>|<page>|<records>|<state>|<page size>|<mode>"
//     for the JTL (sample_variables), which is how the report knows what each
//     page request was. The page itself is an ordinary JMeter sample of its own:
//     nothing is merged, so every page keeps its own time, size and result.
//
// States: MORE   another page follows            END     last page - the data is complete
//         FAILED the page failed or could not be read - the data is incomplete
//         REPEAT the API returned the same page again - stopped, data incomplete
//         NA     pagination is switched off for this API
//
// There is no page limit and no record limit: the loop ends only on END, FAILED
// or REPEAT (a repeated page would otherwise loop forever).
//
// A run without pagination (PAGINATION_MODE unset - also every Route App
// and Sales Order run) ends the loop after the first request and changes nothing
// else. All state is in this thread's own JMeter variables, so concurrent users
// page independently and never see each other's pages.
import groovy.json.JsonSlurper
import java.net.URI
import java.security.MessageDigest

String mode = vars.get("PAGE_MODE") ?: "off"
String runMode = (System.getenv("PAGINATION_MODE") ?: "").trim().toLowerCase()
boolean pagingRun = runMode == "all"

int page = (vars.get("PAGE_NO") ?: "1") as int
String seq = vars.get("PAGE_SEQ") ?: "0"
String sizeText = vars.get("PAGE_SIZE_N") ?: "0"
String state = "END"
boolean more = false
int records = -1
String note = ""

if (mode == "off") {
    vars.put("PAGE_MORE", "false")
    if (pagingRun) vars.put("REC_PAGING", seq + "|" + page + "||NA||off")
    return
}

try {
    int size = sizeText as int
    String type = vars.get("PAGE_TYPE") ?: "link"
    String nextUrl = null

    if (!prev.isSuccessful()) {
        state = "FAILED"
        note = "Page " + page + " failed: " + prev.getResponseCode() + " " + (prev.getResponseMessage() ?: "")
    } else {
        String body = prev.getResponseDataAsString() ?: ""
        def json = null
        try {
            json = new JsonSlurper().parseText(body)
        } catch (Exception e) {
            state = "FAILED"
            note = "Page " + page + ": the response is not valid JSON, so the next page cannot be found"
        }

        if (state != "FAILED") {
            // The record list: the root array, Sage's $resources, or the first array found.
            def items = null
            if (json instanceof List) {
                items = json
            } else if (json instanceof Map) {
                items = json.get('$resources') instanceof List ? json.get('$resources') : null
                if (items == null) {
                    for (String k : ['items', 'data', 'results', 'records', 'rows', 'content']) {
                        if (json.get(k) instanceof List) { items = json.get(k); break }
                    }
                }
                if (items == null) items = json.values().find { it instanceof List }
            }
            if (items == null) {
                state = "FAILED"
                note = "Page " + page + ": no record list found in the response"
            } else {
                records = items.size()
                vars.put("PAGE_TOTAL", String.valueOf((vars.get("PAGE_TOTAL") ?: "0") as long + records))

                if (records == 0) {
                    state = "END"                    // an empty page is the end of the data
                } else if (type == "link") {
                    def links = (json instanceof Map) ? json.get('$links') : null
                    def next = (links instanceof Map && links.get('$next') instanceof Map) ? links.get('$next').get('$url') : null
                    if (next) {
                        more = true
                        nextUrl = next as String
                        // The "$next" link carries no page size: keep the one used for page 1.
                        String count = vars.get("PAGE_COUNT") ?: ""
                        if (count && !(nextUrl =~ /[?&]count=/)) nextUrl = nextUrl + (nextUrl.contains("?") ? "&" : "?") + "count=" + count
                        Set seen = (Set) vars.getObject("PAGE_SEEN")
                        if (seen != null && !seen.add(nextUrl)) {
                            more = false
                            state = "REPEAT"
                            note = "Page " + page + ": the next-page link was already requested"
                        }
                    }
                } else {
                    // page / offset: a page shorter than the page size is the last one
                    // (no size known: keep going until an empty page).
                    more = size > 0 ? records >= size : true
                    String hash = new BigInteger(1, MessageDigest.getInstance("MD5").digest(body.getBytes("UTF-8"))).toString(16)
                    if (more && hash == vars.get("PAGE_LAST_HASH")) {
                        more = false
                        state = "REPEAT"
                        note = "Page " + page + ": the same records were returned again"
                    }
                    vars.put("PAGE_LAST_HASH", hash)
                    if (more) {
                        long start = (vars.get("PAGE_START") ?: "0") as long
                        long value = type == "page" ? start + page : start + (long) page * size
                        String param = vars.get("PAGE_PARAM")
                        String base = vars.get("PAGE_BASE_URL")
                        def m = (base =~ ("(?<=[?&])" + java.util.regex.Pattern.quote(param) + "=[^&]*"))
                        nextUrl = m.find() ? base.substring(0, m.start()) + param + "=" + value + base.substring(m.end()) : base + (base.contains("?") ? "&" : "?") + param + "=" + value
                    }
                }
            }
        }
    }

    if (more) {
        // Same host as the first page, or the thread stops: credentials never follow a link elsewhere.
        URI uri = new URI(nextUrl.replace(" ", "%20"))
        int port = uri.getPort()
        String origin = (uri.getScheme() ?: "").toLowerCase() + "://" + (uri.getHost() ?: "").toLowerCase() + ":" +
            (port == -1 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : port)
        if (origin != vars.get("PAGE_ORIGIN")) {
            more = false
            state = "FAILED"
            note = "Page " + page + ": the next-page link points to a different host (" + origin + ")"
        } else {
            String path = uri.getRawPath()
            if (uri.getRawQuery()) path = path + "?" + uri.getRawQuery()
            vars.put("v_path", path)
            vars.put("PAGE_NO", String.valueOf(page + 1))
            state = "MORE"
        }
    }
} catch (Exception e) {
    more = false
    state = "FAILED"
    note = "Page " + page + ": pagination error - " + e.getMessage()
    log.error("Paginate: " + note)
}

vars.put("PAGE_MORE", more ? "true" : "false")
vars.put("REC_PAGING", seq + "|" + page + "|" + (records >= 0 ? records : "") + "|" + state + "|" + sizeText + "|" + mode)
if (note && !vars.get("REC_ERROR")) vars.put("REC_ERROR", note)
