/*
 * Pagination section of the HTML report, drawn from content/js/report-pagination.js
 * (written from results.jtl by scripts\Write-ReportPaginationInfo.ps1).
 *
 * Every page request is an ordinary sample of its own (see the Statistics table,
 * where the pages of an API are grouped under that API). This section adds what
 * Statistics cannot show: per API, how many pages and records one user needed, how
 * long the whole pagination took, and - most important - whether the complete
 * dataset was really retrieved. Hidden unless the run used pagination.
 */
(function () {
    var data = (typeof REPORT_PAGINATION !== "undefined") ? REPORT_PAGINATION : null;
    var panel = document.getElementById("paginationPanel");
    if (!panel || !data || !data.enabled) return;

    function esc(text) {
        return String(text === null || text === undefined ? "" : text)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function ms(v) {
        v = Number(v) || 0;
        if (v >= 60000) return (v / 60000).toFixed(2) + " min";
        if (v >= 1000) return (v / 1000).toFixed(2) + " s";
        return Math.round(v) + " ms";
    }
    function int(v) {
        return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    function card(label, value, cls) {
        return '<div class="client-stat-card ' + (cls || "") + '"><div class="client-stat-label">' + esc(label) +
            '</div><div class="client-stat-value">' + value + '</div></div>';
    }
    var STATUS_CLASS = { "Complete": "label-success", "Incomplete": "label-danger", "Not paged": "label-default" };
    var STATE_TEXT = { MORE: "more pages", END: "last page", FAILED: "failed", REPEAT: "repeated page", NA: "not paged" };

    var modeText = "All pages, 1,000 records per page (until the API has no more records)";
    var apis = data.apis || [];
    var paged = apis.filter(function (a) { return a.enabled; });

    var overall = data.incompleteRuns > 0 ? "Incomplete" : "Complete";
    var html = '<div class="client-stat-row" style="margin-bottom:12px;">' +
        card("Pagination Mode", esc(modeText)) +
        card("APIs", int(paged.length)) +
        card("Page Requests", int(data.pages)) +
        card("Records Retrieved", int(data.records)) +
        card("Failed Page Requests", int(data.failedPages), data.failedPages > 0 ? "client-stat-failed" : "client-stat-passed") +
        card("Complete Runs", int(data.completeRuns) + " of " + int(data.runs), data.incompleteRuns > 0 ? "client-stat-failed" : "client-stat-passed") +
        card("Overall Pagination Status", '<span class="label ' + (STATUS_CLASS[overall] || "label-default") + '">' + esc(overall) + '</span>') +
        '</div>';

    if (data.incompleteRuns > 0) {
        html += '<div class="alert alert-danger" style="text-align:left;"><strong>The complete dataset was NOT retrieved for ' +
            int(data.incompleteRuns) + ' run(s).</strong> Their record counts are partial. Open the API row to see the page that stopped each run.</div>';
    }
    html += '<p style="text-align:left;color:#666;">A <em>run</em> is one user paging through one API. Total Duration is the sum of that run\'s page response times. ' +
        'Statistics counts every page request as a sample of its API. Click an API for its page-by-page details.</p>';

    html += '<table class="table table-bordered table-condensed" id="paginationTable"><thead><tr>' +
        ['API Name', 'Pagination Enabled', 'Page Size', 'Runs', 'Total Pages', 'Total Records', 'Total Pagination Duration (avg / max per run)',
         'Avg Page Time', 'Min Page Time', 'Max Page Time', 'Failed Pages', 'Status', 'Complete Dataset Retrieved']
            .map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';

    apis.forEach(function (a, i) {
        var complete;
        if (!a.enabled) complete = "-";
        else if (a.incompleteRuns > 0) complete = '<span class="label label-danger">No (' + a.completeRuns + ' of ' + a.runs + ' runs)</span>';
        else complete = '<span class="label label-success">Yes</span>';
        html += '<tr class="pg-row" data-api="' + i + '" style="cursor:pointer;">' +
            '<td style="text-align:left;">' + esc(a.name) + '</td>' +
            '<td>' + (a.enabled ? "Yes" : "No") + '</td>' +
            '<td>' + esc(a.pageSize || (a.enabled ? "API default" : "-")) + '</td>' +
            '<td>' + int(a.runs) + '</td><td>' + int(a.pages) + '</td><td>' + (a.enabled ? int(a.records) : '-') + '</td>' +
            '<td>' + ms(a.avgRunMs) + ' / ' + ms(a.maxRunMs) + '</td>' +
            '<td>' + ms(a.pageAvgMs) + '</td><td>' + ms(a.pageMinMs) + '</td><td>' + ms(a.pageMaxMs) + '</td>' +
            '<td' + (a.failedPages > 0 ? ' style="color:#c00;font-weight:bold;"' : '') + '>' + int(a.failedPages) + '</td>' +
            '<td><span class="label ' + (STATUS_CLASS[a.status] || "label-default") + '">' + esc(a.status) + '</span></td>' +
            '<td>' + complete + '</td></tr>' +
            '<tr class="pg-detail" id="pg-detail-' + i + '" style="display:none;"><td colspan="13" style="text-align:left;"></td></tr>';
    });
    html += '</tbody></table>';
    if (data.detailTruncated) {
        html += '<p style="text-align:left;color:#666;">Page-level details are shown for every incomplete run and for as many complete runs as fit; the rest are summarised above.</p>';
    }

    document.getElementById("paginationBody").innerHTML = html;
    panel.style.display = "";

    function detailHtml(a) {
        var out = '';
        if (a.incomplete && a.incomplete.length) {
            out += '<p><strong>Incomplete runs</strong></p><table class="table table-bordered table-condensed"><thead><tr>' +
                '<th>Thread</th><th>Pages Requested</th><th>Records Retrieved</th><th>Stopped At Page</th><th>Status Code</th><th>Why</th><th>Failed Request</th></tr></thead><tbody>';
            a.incomplete.forEach(function (r) {
                out += '<tr><td>' + esc(r.thread) + '</td><td>' + int(r.pages) + '</td><td>' + int(r.records) + '</td><td>' + int(r.stopPage) +
                    '</td><td>' + esc(r.code) + '</td><td style="text-align:left;">' + esc(r.reason) + '</td>' +
                    '<td style="text-align:left;word-break:break-all;">' + esc(r.url) + '</td></tr>';
            });
            out += '</tbody></table>';
        }
        var rows = a.details || [];
        if (!rows.length) return out + '<p>No page details were kept for this API.</p>';
        out += '<p><strong>Page requests</strong> (' + rows.length + ' shown)</p><table class="table table-bordered table-condensed"><thead><tr>' +
            '<th>Thread</th><th>Run</th><th>Page</th><th>Records</th><th>Response Time</th><th>Status Code</th><th>Page State</th></tr></thead><tbody>';
        rows.forEach(function (r) {
            out += '<tr' + (r[7] ? '' : ' style="color:#c00;"') + '><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' +
                (r[3] === null ? '-' : int(r[3])) + '</td><td>' + ms(r[4]) + '</td><td>' + esc(r[5]) + '</td><td>' + esc(STATE_TEXT[r[6]] || r[6]) + '</td></tr>';
        });
        return out + '</tbody></table>';
    }

    var rowsEl = document.querySelectorAll("#paginationTable .pg-row");
    Array.prototype.forEach.call(rowsEl, function (tr) {
        tr.addEventListener("click", function () {
            var i = tr.getAttribute("data-api");
            var d = document.getElementById("pg-detail-" + i);
            if (d.style.display === "none") {
                var cell = d.children[0];
                if (!cell.getAttribute("data-built")) { cell.innerHTML = detailHtml(apis[Number(i)]); cell.setAttribute("data-built", "1"); }
                d.style.display = "";
            } else {
                d.style.display = "none";
            }
        });
    });
})();
