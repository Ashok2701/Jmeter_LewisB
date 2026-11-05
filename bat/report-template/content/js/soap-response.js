// Statistics "Response" panel: readable view of a SOAP response.
//
// dashboard.js hands every captured response body to SoapResponseView.render().
// A body that is not a SOAP envelope (REST JSON, Query Testing, plain text, an
// HTML error page) is declined (render returns null) and shown exactly as
// before. For a SOAP envelope this builds a summary - HTTP status, service,
// business status, result message, returned fields - above a collapsible,
// indented and highlighted copy of the XML.
//
// Everything is built with createElement / textContent, never innerHTML, so a
// response can never alter the report. The response is only parsed (DOMParser
// does not run scripts), never executed or inserted as markup.
//
// ASCII only: JMeter reads report templates as Windows-1252.
(function(window, document) {
    "use strict";

    var MAX_FIELD_ROWS = 80;

    // ---- DOM helpers ----

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = text;
        }
        return node;
    }

    function localName(node) {
        return node.localName || String(node.nodeName).replace(/^.*:/, "");
    }

    function parseXml(text) {
        try {
            var doc = new DOMParser().parseFromString(text, "application/xml");
            if (doc.getElementsByTagNameNS("*", "parsererror").length || doc.getElementsByTagName("parsererror").length) {
                return null;
            }
            return doc;
        } catch (e) {
            return null;
        }
    }

    function byName(root, name) {
        return Array.prototype.slice.call(root.getElementsByTagNameNS("*", name));
    }

    function childText(parent, name) {
        for (var i = 0; i < parent.childNodes.length; i++) {
            var child = parent.childNodes[i];
            if (child.nodeType === 1 && localName(child) === name) {
                return child.textContent;
            }
        }
        return null;
    }

    // ---- Analysis of the response ----

    function readFields(container) {
        var out = [];
        var flds = byName(container, "FLD");
        for (var i = 0; i < flds.length; i++) {
            out.push({ name: flds[i].getAttribute("NAME") || "", value: flds[i].textContent });
        }
        return out;
    }

    // Reads the Sage X3 result block (<RESULT> with GRP / TAB / FLD) that
    // arrives as the text of <resultXml>.
    function readResult(resultXml) {
        var inner = parseXml(resultXml.replace(/^\s+/, ""));
        if (!inner) {
            return { malformed: true, fields: [], tables: [] };
        }
        var fields = [];
        var tables = [];
        var all = byName(inner, "FLD");
        for (var i = 0; i < all.length; i++) {
            var inTable = false;
            for (var p = all[i].parentNode; p && p.nodeType === 1; p = p.parentNode) {
                if (localName(p) === "TAB") {
                    inTable = true;
                    break;
                }
            }
            if (!inTable) {
                fields.push({ name: all[i].getAttribute("NAME") || "", value: all[i].textContent });
            }
        }
        var tabs = byName(inner, "TAB");
        for (var t = 0; t < tabs.length; t++) {
            var lines = [];
            var lins = byName(tabs[t], "LIN");
            for (var l = 0; l < lins.length; l++) {
                lines.push({ num: lins[l].getAttribute("NUM") || String(l + 1), fields: readFields(lins[l]) });
            }
            tables.push({ id: tabs[t].getAttribute("ID") || "", size: tabs[t].getAttribute("SIZE"), lines: lines });
        }
        return { malformed: false, fields: fields, tables: tables };
    }

    // Returns null when the body is not a SOAP envelope at all.
    function analyse(body) {
        var trimmed = String(body).replace(/^\s+|\s+$/g, "");
        if (trimmed.charAt(0) !== "<") {
            return null;
        }
        var doc = parseXml(trimmed);
        if (!doc) {
            return /Envelope/.test(trimmed.slice(0, 600)) ? { malformed: true } : null;
        }
        if (localName(doc.documentElement) !== "Envelope") {
            return null;
        }

        var info = { malformed: false, fault: null, status: null, messages: [], result: null };

        var faults = byName(doc, "Fault");
        if (faults.length) {
            info.fault = {
                code: childText(faults[0], "faultcode"),
                text: childText(faults[0], "faultstring")
            };
        }

        var statuses = byName(doc, "status");
        if (statuses.length) {
            info.status = statuses[0].textContent.replace(/^\s+|\s+$/g, "");
        }

        // Sage X3 messages: <messages><type>3</type><message>text</message>...
        var msgs = byName(doc, "message");
        for (var i = 0; i < msgs.length; i++) {
            var type = childText(msgs[i].parentNode, "type");
            if (type !== null) {
                info.messages.push({ type: type.replace(/^\s+|\s+$/g, ""), text: msgs[i].textContent.replace(/^\s+|\s+$/g, "") });
            }
        }

        var results = byName(doc, "resultXml");
        if (results.length && results[0].textContent.replace(/\s+/g, "") !== "") {
            info.result = readResult(results[0].textContent);
        }
        return info;
    }

    var MESSAGE_FIELD = /^O_\w*(?:MESS|MSG)\w*$/i;

    function messageType(type) {
        return { "0": "Info", "1": "Info", "2": "Warning", "3": "Error" }[type] || ("Type " + type);
    }

    // Business status is only what the response itself proves. A SOAP Fault,
    // an error-type Sage message, a Sage status of 0, malformed XML or a
    // non-2xx HTTP code is a failure. Anything else is "Unknown": a service's
    // own result fields (O_FLAG, O_XFLG, ...) mean different things per
    // service, so this view does not guess whether they mean success.
    function judge(info, code) {
        var reasons = [];
        if (/^\d+$/.test(code) && (Number(code) < 200 || Number(code) > 299)) {
            reasons.push("HTTP status " + code);
        }
        if (info.malformed) {
            reasons.push("The response is not valid XML (it may be truncated)");
        }
        if (info.fault) {
            reasons.push("SOAP Fault" + (info.fault.text ? ": " + info.fault.text : ""));
        }
        var i;
        for (i = 0; !info.malformed && i < info.messages.length; i++) {
            if (info.messages[i].type === "3") {
                reasons.push(/^Sage error/i.test(info.messages[i].text) ? info.messages[i].text : "Sage error: " + info.messages[i].text);
            }
        }
        if (info.status === "0") {
            reasons.push("Sage reported status 0");
        }
        if (info.result && info.result.malformed) {
            reasons.push("The returned result block is not valid XML");
        }
        if (reasons.length) {
            return { label: "Failed", css: "failed", detail: reasons.join(" | ") };
        }
        if (info.malformed) {
            return { label: "Unknown", css: "unknown", detail: "" };
        }
        return {
            label: "Unknown",
            css: "unknown",
            detail: "No SOAP Fault or Sage error was returned. What the service's own result values mean " +
                "depends on the service, so success is not assumed."
        };
    }

    function resultMessages(info) {
        var out = [];
        var i;
        if (info.fault && info.fault.text) {
            out.push({ source: "SOAP Fault", text: info.fault.text });
        }
        for (i = 0; !info.malformed && i < info.messages.length; i++) {
            if (info.messages[i].text) {
                out.push({ source: "Sage " + messageType(info.messages[i].type), text: info.messages[i].text });
            }
        }
        if (info.result && !info.result.malformed) {
            for (i = 0; i < info.result.fields.length; i++) {
                var f = info.result.fields[i];
                if (MESSAGE_FIELD.test(f.name) && f.value.replace(/^\s+|\s+$/g, "") !== "") {
                    out.push({ source: f.name, text: f.value.replace(/^\s+|\s+$/g, "") });
                }
            }
        }
        return out;
    }

    // ---- XML formatting and highlighting ----

    var TOKEN_RE = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/[^>]*>|<[^>]*>|[^<]+|</g;

    function kindOf(t) {
        if (t.indexOf("<![CDATA[") === 0) { return "cdata"; }
        if (t.indexOf("<!--") === 0) { return "comment"; }
        if (t.indexOf("<?") === 0) { return "decl"; }
        if (t.indexOf("<!") === 0) { return "decl"; }
        if (t.indexOf("</") === 0) { return "close"; }
        if (t.charAt(0) === "<" && t.length > 1 && t.charAt(t.length - 1) === ">") {
            return t.slice(-2) === "/>" ? "self" : "open";
        }
        return "text";
    }

    function tagName(t) {
        var m = /^<\/?([^\s>\/]+)/.exec(t);
        return m ? m[1] : "";
    }

    // Lines of { depth, text, kind }. Element content is indented; a leaf that
    // holds only text stays on one line; XML inside a CDATA section is
    // indented too. Only whitespace between tags changes - never any text.
    function formatLines(source, baseDepth) {
        var toks = source.match(TOKEN_RE) || [];
        var lines = [];
        var depth = baseDepth;
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i];
            var kind = kindOf(t);
            if (kind === "text") {
                var s = t.replace(/^\s+|\s+$/g, "");
                if (s) {
                    lines.push({ depth: depth, text: s, kind: "text" });
                }
            } else if (kind === "open") {
                var n1 = toks[i + 1];
                var n2 = toks[i + 2];
                if (n1 !== undefined && kindOf(n1) === "close" && tagName(n1) === tagName(t)) {
                    lines.push({ depth: depth, text: t + n1, kind: "inline" });
                    i += 1;
                } else if (n1 !== undefined && n2 !== undefined && kindOf(n1) === "text" &&
                           kindOf(n2) === "close" && tagName(n2) === tagName(t) && !/[\r\n]/.test(n1.replace(/^\s+|\s+$/g, ""))) {
                    lines.push({ depth: depth, text: t + n1.replace(/^\s+|\s+$/g, "") + n2, kind: "inline" });
                    i += 2;
                } else {
                    lines.push({ depth: depth, text: t, kind: "inline" });
                    depth++;
                }
            } else if (kind === "close") {
                depth = Math.max(baseDepth, depth - 1);
                lines.push({ depth: depth, text: t, kind: "inline" });
            } else if (kind === "cdata") {
                var inner = t.slice(9, -3);
                if (/^\s*</.test(inner)) {
                    lines.push({ depth: depth, text: "<![CDATA[", kind: "cdatamark" });
                    lines = lines.concat(formatLines(inner.replace(/^\s+|\s+$/g, ""), depth + 1));
                    lines.push({ depth: depth, text: "]]>", kind: "cdatamark" });
                } else {
                    lines.push({ depth: depth, text: t, kind: "cdatamark" });
                }
            } else {
                lines.push({ depth: depth, text: t, kind: kind });
            }
        }
        return lines;
    }

    function span(parent, className, text) {
        parent.appendChild(el("span", className, text));
    }

    function appendTag(parent, t) {
        var m = /^(<\/?)([^\s>\/]+)([\s\S]*?)(\/?>)$/.exec(t);
        if (!m) {
            span(parent, "sx-text", t);
            return;
        }
        span(parent, "sx-punct", m[1]);
        span(parent, "sx-tag", m[2]);
        var rest = m[3];
        var attr = /([^\s=]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
        var last = 0;
        var a;
        while ((a = attr.exec(rest)) !== null) {
            if (a.index > last) {
                span(parent, "sx-punct", rest.slice(last, a.index));
            }
            span(parent, "sx-attr", a[1]);
            span(parent, "sx-punct", a[2]);
            span(parent, "sx-val", a[3]);
            last = attr.lastIndex;
        }
        if (last < rest.length) {
            span(parent, "sx-punct", rest.slice(last));
        }
        span(parent, "sx-punct", m[4]);
    }

    function appendLine(pre, line) {
        pre.appendChild(document.createTextNode(new Array(line.depth + 1).join("  ")));
        if (line.kind === "cdatamark") {
            span(pre, "sx-cdata", line.text);
        } else if (line.kind === "comment") {
            span(pre, "sx-comment", line.text);
        } else if (line.kind === "decl") {
            span(pre, "sx-decl", line.text);
        } else if (line.kind === "text") {
            span(pre, "sx-text", line.text);
        } else {
            var toks = line.text.match(TOKEN_RE) || [];
            for (var i = 0; i < toks.length; i++) {
                if (kindOf(toks[i]) === "text") {
                    span(pre, "sx-text", toks[i]);
                } else {
                    appendTag(pre, toks[i]);
                }
            }
        }
        pre.appendChild(document.createTextNode("\n"));
    }

    function formattedXml(body) {
        var pre = el("pre", "response-body soap-xml");
        var lines = formatLines(String(body).replace(/^\s+|\s+$/g, ""), 0);
        for (var i = 0; i < lines.length; i++) {
            appendLine(pre, lines[i]);
        }
        return pre;
    }

    // ---- Summary ----

    function valueText(v) {
        return v.replace(/^\s+|\s+$/g, "") === "" ? "(empty)" : v;
    }

    function fieldsTable(fields, limit) {
        var table = el("table", "soap-fields");
        var shown = Math.min(fields.length, limit);
        for (var i = 0; i < shown; i++) {
            var row = table.insertRow(-1);
            row.appendChild(el("th", null, fields[i].name));
            var cell = el("td", fields[i].value.replace(/^\s+|\s+$/g, "") === "" ? "soap-empty" : null, valueText(fields[i].value));
            row.appendChild(cell);
        }
        return table;
    }

    function returnedData(info) {
        var box = el("div", "soap-data");
        if (info.malformed || !info.result) {
            box.appendChild(el("div", "soap-none", info.malformed ? "Not available (the response could not be read)." : "No result data was returned."));
            return box;
        }
        var result = info.result;
        if (result.malformed) {
            box.appendChild(el("div", "soap-none", "The result block could not be read; see the raw XML."));
            return box;
        }
        var inputs = [];
        var outputs = [];
        for (var i = 0; i < result.fields.length; i++) {
            (/^I_/i.test(result.fields[i].name) ? inputs : outputs).push(result.fields[i]);
        }
        var count = 0;
        if (outputs.length) {
            box.appendChild(el("div", "soap-subtitle", "Output values"));
            box.appendChild(fieldsTable(outputs, MAX_FIELD_ROWS));
            count += outputs.length;
        }
        if (inputs.length) {
            box.appendChild(el("div", "soap-subtitle", "Input values (echoed back by the service)"));
            box.appendChild(fieldsTable(inputs, MAX_FIELD_ROWS));
            count += inputs.length;
        }
        for (var t = 0; t < result.tables.length; t++) {
            var tab = result.tables[t];
            var lineCount = tab.lines.length;
            box.appendChild(el("div", "soap-subtitle", "Table " + tab.id + ": " + lineCount + (lineCount === 1 ? " line" : " lines")));
            for (var l = 0; l < lineCount && count < MAX_FIELD_ROWS; l++) {
                box.appendChild(el("div", "soap-line", "Line " + tab.lines[l].num));
                box.appendChild(fieldsTable(tab.lines[l].fields, MAX_FIELD_ROWS - count));
                count += tab.lines[l].fields.length;
            }
        }
        if (!count && !result.tables.length) {
            box.appendChild(el("div", "soap-none", "The result contains no fields."));
        }
        if (count >= MAX_FIELD_ROWS) {
            box.appendChild(el("div", "soap-none", "Long result: the first fields are listed here; the rest is in the raw XML."));
        }
        return box;
    }

    function summaryRow(table, title, node) {
        var row = table.insertRow(-1);
        row.appendChild(el("th", null, title));
        var cell = document.createElement("td");
        cell.appendChild(node);
        row.appendChild(cell);
    }

    function serviceName(label) {
        return String(label || "").replace(/^\s*SOAP[\s:_-]+/i, "").replace(/^\s+|\s+$/g, "");
    }

    function buildSummary(info, label, code) {
        var verdict = judge(info, code);
        var table = el("table", "soap-summary");

        summaryRow(table, "HTTP Status Code", el("span", null, /^\d+$/.test(code) ? code : "-"));
        summaryRow(table, "SOAP Service Name", el("span", null, serviceName(label) || "-"));

        var status = el("div");
        status.appendChild(el("span", "soap-badge soap-" + verdict.css, verdict.label));
        if (verdict.detail) {
            status.appendChild(el("div", "soap-detail", verdict.detail));
        }
        summaryRow(table, "Business Status", status);

        var messages = info.malformed ? [] : resultMessages(info);
        var msgBox = el("div");
        if (messages.length) {
            for (var i = 0; i < messages.length; i++) {
                var line = el("div", "soap-message");
                line.appendChild(el("span", "soap-source", messages[i].source + ": "));
                line.appendChild(document.createTextNode(messages[i].text));
                msgBox.appendChild(line);
            }
        } else {
            msgBox.appendChild(el("span", "soap-none", info.malformed ? "Not available." : "No message was returned."));
        }
        summaryRow(table, "Result Message", msgBox);

        summaryRow(table, "Returned Data", returnedData(info));
        return table;
    }

    // ---- Public entry point ----

    // Returns a DOM node for a SOAP response, or null when the body is not SOAP
    // (the caller then shows it as before).
    function render(label, code, body) {
        var info = analyse(body);
        if (!info) {
            return null;
        }
        var wrap = el("div", "soap-response");
        wrap.appendChild(buildSummary(info, label, String(code)));

        var details = el("details", "soap-raw");
        details.appendChild(el("summary", null, "View Raw XML"));
        var formatted = formattedXml(body);
        var original = el("pre", "response-body soap-xml");
        original.textContent = String(body);
        original.style.display = "none";

        var toggle = el("button", "soap-raw-toggle", "Show as received");
        toggle.type = "button";
        toggle.onclick = function() {
            var showOriginal = original.style.display === "none";
            original.style.display = showOriginal ? "" : "none";
            formatted.style.display = showOriginal ? "none" : "";
            toggle.textContent = showOriginal ? "Show formatted" : "Show as received";
        };
        details.appendChild(toggle);
        details.appendChild(formatted);
        details.appendChild(original);
        wrap.appendChild(details);
        return wrap;
    }

    window.SoapResponseView = { render: render, analyse: analyse, judge: judge };
})(window, document);
