<#
    Writes <dashboard>\content\js\report-pagination.js for the run that has just
    finished: the Pagination section of the HTML report.

    Where the data comes from
    -------------------------
    A paged Merchandiser REST run sends one real HTTP sample per page (so every
    page keeps its own time, size and result in results.jtl). scripts\Paginate.groovy
    tags each of them with a REC_PAGING column:

        <sequence>|<page>|<records>|<state>|<page size>|<mode>

    <sequence> numbers one API execution inside one thread, so (thread, sequence)
    is "one user paging through one API". The pages of that execution are put back
    together here:

        pages      = how many page requests it needed
        records    = the sum of the records the pages returned
        duration   = the sum of the page response times (and the wall-clock span)
        complete   = its last page said END (the API has no more records)

    Everything is then rolled up per logical API (API_NAME from the run's source
    CSV, matched by "<METHOD> <path>" like Write-ReportApiGroups.ps1; a label with
    no CSV row stands alone under its own label).

    Nothing is claimed that the responses did not show: "complete" only when the
    last page reported the end of the data (no next-page link, or an empty page),
    and every page of the sequence is present. A failed / repeated
    sequence is listed with the page that stopped it.

    A run without pagination (no REC_PAGING column) writes {"enabled":false}.

    Expected environment variables:
        PAGING_JTL         the run's results.jtl
        PAGING_FILE        target .js file inside the generated dashboard
        PAGING_SOURCE_CSV  the run's uploaded.csv (API_NAME / ENDPOINT / BASE_URL)
#>

$ErrorActionPreference = 'Stop'

$jtl = $env:PAGING_JTL
$target = $env:PAGING_FILE
$sourceCsv = $env:PAGING_SOURCE_CSV
if ([string]::IsNullOrWhiteSpace($jtl) -or [string]::IsNullOrWhiteSpace($target)) {
    Write-Error 'PAGING_JTL and PAGING_FILE must both be set.'
    exit 1
}
if (-not (Test-Path -LiteralPath $jtl)) {
    Write-Error "Results file not found: $jtl"
    exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

public static class JtlPagination
{
    const string PreparePrefix = "Prepare - ";
    // Page-level detail rows kept in the report (incomplete sequences first).
    const int MaxDetailRows = 4000;
    const int MaxIncompleteListed = 25;

    public static bool Enabled;
    public static long PageSamples;
    public static int Apis;
    public static long Sequences;

    class Page
    {
        public int No;
        public int Elapsed;
        public int Records = -1;
        public string State = "";
        public string Code = "";
        public bool Ok;
        public long Ts;
        public string Url = "";
        public string Error = "";
    }

    class Seq
    {
        public string Thread;
        public string Id;
        public string Label;
        public string Mode = "";
        public string Size = "";
        public List<Page> Pages = new List<Page>();
        // filled by Analyse
        public bool Complete;
        public bool NotPaged;   // pagination switched off for this API: neither complete nor incomplete
        public string Final = "";
        public string Why = "";
        public long Records;
        public long SumMs;
        public long WallMs;
        public int Failed;
    }

    class Api
    {
        public string Name;
        public string Label;
        public string Method = "";
        public int Order = int.MaxValue;
        public List<Seq> Seqs = new List<Seq>();
    }

    static List<string> ReadRecord(TextReader reader)
    {
        int c = reader.Read();
        if (c == -1) return null;
        List<string> fields = new List<string>();
        StringBuilder sb = new StringBuilder();
        bool quoted = false;
        while (true)
        {
            if (quoted)
            {
                if (c == -1) break;
                if (c == '"')
                {
                    if (reader.Peek() == '"') { sb.Append('"'); reader.Read(); }
                    else quoted = false;
                }
                else sb.Append((char)c);
            }
            else
            {
                if (c == -1 || c == '\n') break;
                if (c == '"') quoted = true;
                else if (c == ',') { fields.Add(sb.ToString()); sb.Length = 0; }
                else if (c != '\r') sb.Append((char)c);
            }
            c = reader.Read();
        }
        fields.Add(sb.ToString());
        return fields;
    }

    static string NormaliseHeader(string name)
    {
        StringBuilder sb = new StringBuilder();
        foreach (char ch in (name ?? "").Trim().ToLowerInvariant())
            if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) sb.Append(ch);
        return sb.ToString();
    }

    static string Cell(List<string> row, int index)
    {
        return index >= 0 && index < row.Count ? row[index].Trim() : "";
    }

    // "GET /api1/x3/erp/PILOT/X10CITMBP?representation=..." -> API_NAME
    static Dictionary<string, string[]> LoadNames(string csvPath)
    {
        Dictionary<string, string[]> map = new Dictionary<string, string[]>();
        if (string.IsNullOrEmpty(csvPath) || !File.Exists(csvPath)) return map;
        using (FileStream fs = new FileStream(csvPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (StreamReader reader = new StreamReader(fs, Encoding.UTF8, true))
        {
            List<string> header = ReadRecord(reader);
            if (header == null) return map;
            List<string> norm = new List<string>();
            foreach (string h in header) norm.Add(NormaliseHeader(h));
            int iName = norm.IndexOf("apiname");
            int iEndpoint = norm.IndexOf("endpoint");
            int iBase = norm.IndexOf("baseurl");
            int iMethod = norm.IndexOf("method");
            if (iName < 0 || iEndpoint < 0) return map;

            List<List<string>> rows = new List<List<string>>();
            List<string> row;
            string fileBase = "";
            while ((row = ReadRecord(reader)) != null)
            {
                rows.Add(row);
                if (fileBase.Length == 0) fileBase = Cell(row, iBase);
            }
            int order = 0;
            foreach (List<string> r in rows)
            {
                order++;
                string endpoint = Cell(r, iEndpoint);
                string name = Cell(r, iName);
                if (endpoint.Length == 0 || name.Length == 0) continue;
                string rowBase = Cell(r, iBase);
                if (rowBase.Length == 0) rowBase = fileBase;
                string method = Cell(r, iMethod).ToUpperInvariant();
                if (method.Length == 0) method = "GET";
                string full = endpoint.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    || endpoint.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                    ? endpoint : rowBase.TrimEnd('/') + "/" + endpoint.TrimStart('/');
                Uri uri;
                if (!Uri.TryCreate(full, UriKind.Absolute, out uri)) continue;
                // .NET writes the braces of a {USER_CODE:<role>} placeholder as %7B / %7D;
                // the sample label keeps them as they are.
                map[method + " " + uri.PathAndQuery.Replace("%7B", "{").Replace("%7D", "}")] =
                    new string[] { name, order.ToString(CultureInfo.InvariantCulture), method };
            }
        }
        return map;
    }

    static void WriteString(TextWriter w, string s)
    {
        w.Write('"');
        foreach (char c in s ?? "")
        {
            switch (c)
            {
                case '"': w.Write("\\\""); break;
                case '\\': w.Write("\\\\"); break;
                case '\n': w.Write("\\n"); break;
                case '\r': w.Write("\\r"); break;
                case '\t': w.Write("\\t"); break;
                default:
                    if (c < 0x20 || (int)c == 0x2028 || (int)c == 0x2029 || c == '<')
                        w.Write("\\u" + ((int)c).ToString("x4"));
                    else
                        w.Write(c);
                    break;
            }
        }
        w.Write('"');
    }

    static string Num(double v)
    {
        return Math.Round(v, 1, MidpointRounding.AwayFromZero).ToString("0.#", CultureInfo.InvariantCulture);
    }

    // The sequence's outcome, from its pages only.
    static void Analyse(Seq s)
    {
        s.Pages.Sort(delegate (Page a, Page b) { return a.No.CompareTo(b.No); });
        long first = long.MaxValue, last = long.MinValue;
        bool consecutive = true;
        int expect = 1;
        foreach (Page p in s.Pages)
        {
            if (p.Records > 0) s.Records += p.Records;
            s.SumMs += p.Elapsed;
            if (!p.Ok || p.State == "FAILED") s.Failed++;
            if (p.Ts < first) first = p.Ts;
            if (p.Ts + p.Elapsed > last) last = p.Ts + p.Elapsed;
            if (p.No != expect) consecutive = false;
            expect++;
        }
        s.WallMs = s.Pages.Count > 0 ? last - first : 0;
        Page end = s.Pages[s.Pages.Count - 1];
        s.Final = end.State;
        if (!consecutive)
        {
            s.Why = "page numbers are not consecutive - a page is missing from the results";
        }
        else if (end.State == "END")
        {
            s.Complete = true;
        }
else if (end.State == "FAILED")
        {
            s.Why = "page " + end.No + " failed (" + end.Code + ")" + (end.Error.Length > 0 ? ": " + end.Error : "");
        }
        else if (end.State == "REPEAT")
        {
            s.Why = end.Error.Length > 0 ? end.Error : "the API returned the same page again";
        }
        else if (end.State == "NA")
        {
            s.NotPaged = true;
            s.Why = "pagination is switched off for this API";
        }
        else
        {
            s.Why = "the run ended before the last page was requested (last page " + end.No + ")";
        }
    }

    public static void Run(string jtlPath, string csvPath, string targetPath)
    {
        UTF8Encoding utf8NoBom = new UTF8Encoding(false);
        Dictionary<string, string[]> names = LoadNames(csvPath);
        Dictionary<string, Seq> seqs = new Dictionary<string, Seq>();
        List<Seq> seqOrder = new List<Seq>();
        string runMode = "";

        using (FileStream jfs = new FileStream(jtlPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (StreamReader reader = new StreamReader(jfs, Encoding.UTF8, true, 1 << 20))
        {
            List<string> header = ReadRecord(reader);
            int iPaging = header == null ? -1 : header.IndexOf("REC_PAGING");
            if (iPaging < 0)
            {
                File.WriteAllText(targetPath,
                    "/* Auto-generated from results.jtl after each report generation. Do not edit manually. */\n"
                    + "var REPORT_PAGINATION = {\"enabled\":false};\n", utf8NoBom);
                Enabled = false;
                return;
            }
            int iTs = header.IndexOf("timeStamp");
            int iElapsed = header.IndexOf("elapsed");
            int iLabel = header.IndexOf("label");
            int iCode = header.IndexOf("responseCode");
            int iMsg = header.IndexOf("responseMessage");
            int iThread = header.IndexOf("threadName");
            int iSuccess = header.IndexOf("success");
            int iFailMsg = header.IndexOf("failureMessage");
            int iUrl = header.IndexOf("URL");
            int iErr = header.IndexOf("REC_ERROR");
            int need = Math.Max(Math.Max(iLabel, iElapsed), Math.Max(iTs, Math.Max(iThread, iPaging)));

            List<string> row;
            while ((row = ReadRecord(reader)) != null)
            {
                if (row.Count <= need) continue;
                string label = row[iLabel];
                if (label.StartsWith(PreparePrefix, StringComparison.Ordinal)) continue;
                string paging = row[iPaging];
                if (paging.Length == 0 || paging == "null") continue;
                string[] f = paging.Split('|');
                if (f.Length < 6) continue;

                Page p = new Page();
                int n;
                if (!int.TryParse(f[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) continue;
                p.No = n;
                if (f[2].Length > 0 && int.TryParse(f[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) p.Records = n;
                p.State = f[3];
                int el; long ts;
                if (!int.TryParse(row[iElapsed], NumberStyles.Integer, CultureInfo.InvariantCulture, out el)) continue;
                if (!long.TryParse(row[iTs], NumberStyles.Integer, CultureInfo.InvariantCulture, out ts)) continue;
                p.Elapsed = el; p.Ts = ts;
                p.Code = iCode >= 0 ? row[iCode] : "";
                p.Ok = iSuccess >= 0 && string.Equals(row[iSuccess], "true", StringComparison.OrdinalIgnoreCase);
                p.Url = iUrl >= 0 && iUrl < row.Count ? row[iUrl] : "";
                string err = iErr >= 0 && iErr < row.Count && row[iErr] != "null" ? row[iErr] : "";
                if (err.Length == 0 && iFailMsg >= 0 && iFailMsg < row.Count) err = row[iFailMsg];
                if (err.Length == 0 && !p.Ok) err = (iMsg >= 0 && iMsg < row.Count ? row[iMsg] : "") ;
                p.Error = err;
                PageSamples++;

                string key = row[iThread] + "\u0001" + f[0] + "\u0001" + label;
                Seq s;
                if (!seqs.TryGetValue(key, out s))
                {
                    s = new Seq();
                    s.Thread = row[iThread];
                    s.Id = f[0];
                    s.Label = label;
                    s.Mode = f[5];
                    seqs[key] = s;
                    seqOrder.Add(s);
                }
                if (f[4].Length > 0 && f[4] != "0") s.Size = f[4];
                if (s.Mode == "off" && f[5] != "off") s.Mode = f[5];
                if (runMode.Length == 0 && f[5] == "all") runMode = f[5];
                s.Pages.Add(p);
            }
        }

        // Sequences -> logical APIs.
        Dictionary<string, Api> apis = new Dictionary<string, Api>();
        List<Api> apiOrder = new List<Api>();
        foreach (Seq s in seqOrder)
        {
            Analyse(s);
            string name = s.Label;
            int order = int.MaxValue;
            string method = "";
            string[] hit;
            if (names.TryGetValue(s.Label, out hit)) { name = hit[0]; order = int.Parse(hit[1], CultureInfo.InvariantCulture); method = hit[2]; }
            else { int sp = s.Label.IndexOf(' '); if (sp > 0) method = s.Label.Substring(0, sp); }
            string key = method + "\u0001" + name;
            Api a;
            if (!apis.TryGetValue(key, out a))
            {
                a = new Api();
                a.Name = name; a.Label = s.Label; a.Method = method; a.Order = order;
                apis[key] = a;
                apiOrder.Add(a);
            }
            a.Seqs.Add(s);
        }
        apiOrder.Sort(delegate (Api x, Api y)
        {
            int c = x.Order.CompareTo(y.Order);
            return c != 0 ? c : string.CompareOrdinal(x.Name, y.Name);
        });
        Apis = apiOrder.Count;
        Sequences = seqOrder.Count;
        Enabled = true;

        int detailLeft = MaxDetailRows;
        // Incomplete sequences' pages are always kept; the rest fill what is left.
        foreach (Api a in apiOrder)
            foreach (Seq s in a.Seqs)
                if (!s.Complete && !s.NotPaged) detailLeft -= s.Pages.Count;
        if (detailLeft < 0) detailLeft = 0;

        long totalPages = 0, totalRecords = 0, failedPages = 0, incompleteSeqs = 0, completeSeqs = 0;
        using (StreamWriter w = new StreamWriter(targetPath, false, utf8NoBom))
        {
            w.Write("/* Auto-generated from results.jtl after each report generation. Do not edit manually. */\n");
            StringBuilder body = new StringBuilder();
            StringWriter bw = new StringWriter(body);
            bool firstApi = true;
            bool detailTruncated = false;
            foreach (Api a in apiOrder)
            {
                List<int> pageTimes = new List<int>();
                long pages = 0, records = 0, sumMs = 0, maxRunMs = 0, wallSum = 0, failed = 0;
                int complete = 0, incomplete = 0, notPaged = 0;
                string mode = "";
                SortedDictionary<string, int> sizes = new SortedDictionary<string, int>();
                foreach (Seq s in a.Seqs)
                {
                    pages += s.Pages.Count; records += s.Records; sumMs += s.SumMs; wallSum += s.WallMs; failed += s.Failed;
                    if (s.SumMs > maxRunMs) maxRunMs = s.SumMs;
                    if (s.NotPaged) notPaged++;
                    else if (s.Complete) complete++; else incomplete++;
                    if (s.Mode.Length > 0 && s.Mode != "off") mode = s.Mode;
                    if (s.Size.Length > 0) sizes[s.Size] = 1;
                    foreach (Page p in s.Pages) pageTimes.Add(p.Elapsed);
                }
                pageTimes.Sort();
                bool paged = mode.Length > 0 && notPaged < a.Seqs.Count;
                string status;
                if (!paged) status = "Not paged";
                else if (incomplete > 0) status = "Incomplete";
                else status = "Complete";
                totalPages += pages; totalRecords += records; failedPages += failed;
                incompleteSeqs += incomplete; completeSeqs += complete;

                if (!firstApi) bw.Write(',');
                firstApi = false;
                bw.Write("{\"name\":"); WriteString(bw, a.Name);
                bw.Write(",\"method\":"); WriteString(bw, a.Method);
                bw.Write(",\"enabled\":" + (paged ? "true" : "false"));
                bw.Write(",\"mode\":"); WriteString(bw, mode);
                bw.Write(",\"pageSize\":"); WriteString(bw, string.Join(", ", new List<string>(sizes.Keys).ToArray()));
                bw.Write(",\"runs\":" + a.Seqs.Count);
                bw.Write(",\"pages\":" + pages);
                bw.Write(",\"records\":" + records);
                bw.Write(",\"avgRunMs\":" + Num(a.Seqs.Count == 0 ? 0 : (double)sumMs / a.Seqs.Count));
                bw.Write(",\"maxRunMs\":" + maxRunMs);
                bw.Write(",\"avgWallMs\":" + Num(a.Seqs.Count == 0 ? 0 : (double)wallSum / a.Seqs.Count));
                bw.Write(",\"pageAvgMs\":" + Num(pageTimes.Count == 0 ? 0 : (double)sumMs / pageTimes.Count));
                bw.Write(",\"pageMinMs\":" + (pageTimes.Count == 0 ? 0 : pageTimes[0]));
                bw.Write(",\"pageMaxMs\":" + (pageTimes.Count == 0 ? 0 : pageTimes[pageTimes.Count - 1]));
                bw.Write(",\"failedPages\":" + failed);
                bw.Write(",\"completeRuns\":" + complete);
                bw.Write(",\"incompleteRuns\":" + incomplete);
                bw.Write(",\"status\":"); WriteString(bw, status);

                // Why runs did not finish, with the page that stopped them.
                bw.Write(",\"incomplete\":[");
                int listed = 0;
                foreach (Seq s in a.Seqs)
                {
                    if (s.Complete || s.NotPaged) continue;
                    if (listed >= MaxIncompleteListed) break;
                    Page stop = s.Pages[s.Pages.Count - 1];
                    foreach (Page p in s.Pages) if (!p.Ok || p.State == "FAILED") { stop = p; break; }
                    if (listed++ > 0) bw.Write(',');
                    bw.Write("{\"thread\":"); WriteString(bw, s.Thread);
                    bw.Write(",\"pages\":" + s.Pages.Count);
                    bw.Write(",\"records\":" + s.Records);
                    bw.Write(",\"state\":"); WriteString(bw, s.Final);
                    bw.Write(",\"stopPage\":" + stop.No);
                    bw.Write(",\"code\":"); WriteString(bw, stop.Code);
                    bw.Write(",\"reason\":"); WriteString(bw, s.Why);
                    bw.Write(",\"url\":"); WriteString(bw, stop.Url);
                    bw.Write('}');
                }
                bw.Write("]");

                // Page-level details, kept for troubleshooting:
                // [thread, run, page, records, ms, code, state, ok]
                bw.Write(",\"details\":[");
                bool firstRow = true;
                foreach (Seq s in a.Seqs)
                {
                    bool bad = !s.Complete && !s.NotPaged;
                    if (!bad)
                    {
                        if (detailLeft < s.Pages.Count) { detailTruncated = true; continue; }
                        detailLeft -= s.Pages.Count;
                    }
                    foreach (Page p in s.Pages)
                    {
                        if (!firstRow) bw.Write(',');
                        firstRow = false;
                        bw.Write('['); WriteString(bw, s.Thread);
                        bw.Write(',' + s.Id.Replace("\"", ""));
                        bw.Write(',' + p.No.ToString(CultureInfo.InvariantCulture));
                        bw.Write(',' + (p.Records >= 0 ? p.Records.ToString(CultureInfo.InvariantCulture) : "null"));
                        bw.Write(',' + p.Elapsed.ToString(CultureInfo.InvariantCulture) + ',');
                        WriteString(bw, p.Code); bw.Write(',');
                        WriteString(bw, p.State);
                        bw.Write(p.Ok ? ",true]" : ",false]");
                    }
                }
                bw.Write("]}");
            }
            bw.Flush();

            w.Write("var REPORT_PAGINATION = {\"enabled\":true,\"mode\":"); WriteString(w, runMode);
            w.Write(",\"apiCount\":" + apiOrder.Count);
            w.Write(",\"runs\":" + (completeSeqs + incompleteSeqs)); // paged runs only
            w.Write(",\"pages\":" + totalPages);
            w.Write(",\"records\":" + totalRecords);
            w.Write(",\"failedPages\":" + failedPages);
            w.Write(",\"completeRuns\":" + completeSeqs);
            w.Write(",\"incompleteRuns\":" + incompleteSeqs);
            w.Write(",\"detailTruncated\":" + (detailTruncated ? "true" : "false"));
            w.Write(",\"apis\":[");
            w.Write(body.ToString());
            w.Write("]};\n");
        }
    }
}
'@

$jtlFull = (Resolve-Path -LiteralPath $jtl).ProviderPath
[JtlPagination]::Run($jtlFull, $sourceCsv, $target)
if ([JtlPagination]::Enabled) {
    Write-Host ("Pagination: {0} APIs, {1} runs, {2} page requests" -f [JtlPagination]::Apis, [JtlPagination]::Sequences, [JtlPagination]::PageSamples)
} else {
    Write-Host 'Pagination: not used in this run.'
}
