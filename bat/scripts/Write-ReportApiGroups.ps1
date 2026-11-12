<#
    Writes <dashboard>\content\js\report-api-groups.js for the run that has just
    finished: the Statistics table grouped by LOGICAL API instead of one row per
    role-specific execution.

    Why this exists
    ---------------
    A Merchandiser REST run executes the same logical API (e.g. "Products") once
    per user role (Merchandiser, Sales Manager, DSM, ...). JMeter's own Statistics
    table lists every execution as a separate row, which grows to hundreds of rows
    as APIs and roles are added. The JTL only records "GET <path>" as a sample's
    label - the CSV's API_NAME never reaches it - so the role and the logical API
    are recovered here from the run's source CSV (uploaded.csv, kept next to
    test-data.csv by the web app):

        API_NAME = "<Role> - <API name>"     e.g. "DSM - Products"

    split at the FIRST " - ". Nothing is hard-coded: roles and API names are
    whatever the CSV contains. Each CSV row is matched to its JTL samples by
    "<METHOD> <path>" (the label the test plan builds from the same row).

    Grouping is switched on only when the CSV really has several roles (two or
    more distinct role prefixes). Otherwise this writes {"enabled":false} and the
    report shows its normal per-label Statistics table - Route App, Sales Order
    Adjustment and any other CSV are unaffected.

    A logical API is identified by HTTP method + API name. The endpoint is NOT part
    of the key: in the Merchandiser CSV each role calls a different Sage
    representation (X10CITMBP, X10CITMBP1, ...) for the same logical API.

    Statistics are computed from the individual JTL samples (all roles pooled),
    never by averaging per-role averages. Raw elapsed values are kept per
    (API, role) and pooled and sorted once at the end, so percentiles and the
    median are exact. Samples are streamed (no Import-Csv), like the other
    Write-Report*.ps1 scripts, because a JTL can run to gigabytes.

    Expected environment variables:
        API_GROUPS_JTL         the run's results.jtl
        API_GROUPS_FILE        target .js file inside the generated dashboard
        API_GROUPS_SOURCE_CSV  the run's uploaded.csv (API_NAME / ENDPOINT / ...)
#>

$ErrorActionPreference = 'Stop'

$jtl = $env:API_GROUPS_JTL
$target = $env:API_GROUPS_FILE
$sourceCsv = $env:API_GROUPS_SOURCE_CSV
if ([string]::IsNullOrWhiteSpace($jtl) -or [string]::IsNullOrWhiteSpace($target)) {
    Write-Error 'API_GROUPS_JTL and API_GROUPS_FILE must both be set.'
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

public static class JtlApiGroups
{
    // Same filter as report-generator.properties: internal "Prepare - ..."
    // samplers never reach the report.
    const string PreparePrefix = "Prepare - ";
    const string RoleSeparator = " - ";

    class Mapping
    {
        public string Role;
        public string Api;
        public int Order;
    }

    class Member
    {
        public string Role;
        public string Label;
        public int Order;
        public List<int> Elapsed = new List<int>();
        public long Failed;
        public long Bytes;
        public long Sent;
        public long FirstStart = long.MaxValue;
        public long LastEnd = long.MinValue;
        public Dictionary<string, long> Codes = new Dictionary<string, long>();
        public string Method = "";
    }

    class Group
    {
        public string Name;
        public string Method = "";
        public int Order = int.MaxValue;
        public List<Member> Members = new List<Member>();
    }

    public static long SampleCount;
    public static long MappedSamples;
    public static int RoleCount;
    public static bool Enabled;

    // ---- CSV reading (RFC 4180, as JMeter / the web app write it) ----
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

    // "GET /api1/x3/erp/PILOT/X10CITMBP?representation=..." -> Mapping(role, api)
    static Dictionary<string, Mapping> LoadMappings(string csvPath)
    {
        Dictionary<string, Mapping> map = new Dictionary<string, Mapping>();
        if (string.IsNullOrEmpty(csvPath) || !File.Exists(csvPath)) return map;

        // Shared read access: the CSV may be open in another program.
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

                string full;
                if (endpoint.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    || endpoint.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    full = endpoint;
                else
                    full = rowBase.TrimEnd('/') + "/" + endpoint.TrimStart('/');

                Uri uri;
                if (!Uri.TryCreate(full, UriKind.Absolute, out uri)) continue;

                Mapping m = new Mapping();
                m.Order = order;
                int sep = name.IndexOf(RoleSeparator, StringComparison.Ordinal);
                if (sep > 0 && sep + RoleSeparator.Length < name.Length)
                {
                    m.Role = name.Substring(0, sep).Trim();
                    m.Api = name.Substring(sep + RoleSeparator.Length).Trim();
                }
                else
                {
                    m.Role = "";
                    m.Api = name;
                }
                // .NET writes the braces of a {USER_CODE:<role>} placeholder as
                // %7B / %7D, but the sample label (built by the web app) keeps them
                // as they are - normalise so those APIs still match their label.
                map[method + " " + uri.PathAndQuery.Replace("%7B", "{").Replace("%7D", "}")] = m;
            }
        }
        return map;
    }

    // ---- statistics ----
    // The percentile method JMeter's own report uses (commons-math "legacy":
    // position p*(n+1)/100, linearly interpolated between neighbours), so a
    // grouped row and the Total row agree. Checked against a real statistics.json.
    static double Percentile(int[] sorted, double p)
    {
        int n = sorted.Length;
        if (n == 0) return 0;
        double pos = p * (n + 1) / 100.0;
        if (pos < 1) return sorted[0];
        if (pos >= n) return sorted[n - 1];
        int i = (int)Math.Floor(pos);
        return sorted[i - 1] + (pos - i) * (sorted[i] - sorted[i - 1]);
    }

    static double Round(double v, int digits)
    {
        return Math.Round(v, digits, MidpointRounding.AwayFromZero);
    }

    // [samples, failed, error %, mean, min, max, median, p90, p95, p99,
    //  throughput, received KB/s, sent KB/s] - JMeter's Statistics column order.
    static double[] Stats(int[] sorted, long failed, long bytes, long sent, long firstStart, long lastEnd)
    {
        double[] s = new double[13];
        long n = sorted.Length;
        s[0] = n;
        s[1] = failed;
        s[2] = n == 0 ? 0 : failed * 100.0 / n;
        if (n > 0)
        {
            double sum = 0;
            foreach (int v in sorted) sum += v;
            s[3] = sum / n;
            s[4] = sorted[0];
            s[5] = sorted[sorted.Length - 1];
            s[6] = Percentile(sorted, 50);
            s[7] = Percentile(sorted, 90);
            s[8] = Percentile(sorted, 95);
            s[9] = Percentile(sorted, 99);
        }
        double seconds = (lastEnd - firstStart) / 1000.0;
        if (n > 0 && seconds > 0)
        {
            s[10] = n / seconds;
            s[11] = bytes / 1024.0 / seconds;
            s[12] = sent / 1024.0 / seconds;
        }
        return s;
    }

    static void WriteString(TextWriter w, string s)
    {
        w.Write('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': w.Write("\\\""); break;
                case '\\': w.Write("\\\\"); break;
                case '\n': w.Write("\\n"); break;
                case '\r': w.Write("\\r"); break;
                case '\t': w.Write("\\t"); break;
                default:
                    // "<" is escaped so a label can never close the <script> tag.
                    if (c < 0x20 || (int)c == 0x2028 || (int)c == 0x2029 || c == '<')
                        w.Write("\\u" + ((int)c).ToString("x4"));
                    else
                        w.Write(c);
                    break;
            }
        }
        w.Write('"');
    }

    static void WriteStats(TextWriter w, double[] s)
    {
        w.Write('[');
        for (int i = 0; i < s.Length; i++)
        {
            if (i > 0) w.Write(',');
            double v = (i == 0 || i == 1) ? s[i] : Round(s[i], i >= 10 ? 3 : 2);
            w.Write(v.ToString("0.###", CultureInfo.InvariantCulture));
        }
        w.Write(']');
    }

    static void WriteCodes(TextWriter w, Dictionary<string, long> codes)
    {
        List<KeyValuePair<string, long>> list = new List<KeyValuePair<string, long>>(codes);
        list.Sort(delegate (KeyValuePair<string, long> a, KeyValuePair<string, long> b)
        {
            int c = b.Value.CompareTo(a.Value);
            return c != 0 ? c : string.CompareOrdinal(a.Key, b.Key);
        });
        w.Write('[');
        for (int i = 0; i < list.Count; i++)
        {
            if (i > 0) w.Write(',');
            w.Write('[');
            WriteString(w, list[i].Key);
            w.Write(',');
            w.Write(list[i].Value.ToString(CultureInfo.InvariantCulture));
            w.Write(']');
        }
        w.Write(']');
    }

    // The endpoint without its query string: role-specific filters
    // (where=... user codes) are not part of what identifies the API.
    static string PathOnly(string label)
    {
        int sp = label.IndexOf(' ');
        string p = sp >= 0 ? label.Substring(sp + 1) : label;
        int q = p.IndexOf('?');
        return q >= 0 ? p.Substring(0, q) : p;
    }

    static string FullPath(string label)
    {
        int sp = label.IndexOf(' ');
        return sp >= 0 ? label.Substring(sp + 1) : label;
    }

    public static void Run(string jtlPath, string csvPath, string targetPath)
    {
        Dictionary<string, Mapping> map = LoadMappings(csvPath);

        // Grouping only makes sense when the CSV names several roles.
        HashSet<string> roles = new HashSet<string>();
        foreach (Mapping m in map.Values)
            if (m.Role.Length > 0) roles.Add(m.Role);
        RoleCount = roles.Count;
        Enabled = roles.Count >= 2;

        UTF8Encoding utf8NoBom = new UTF8Encoding(false);
        if (!Enabled)
        {
            File.WriteAllText(targetPath,
                "/* Auto-generated from results.jtl after each report generation. Do not edit manually. */\n"
                + "var REPORT_API_GROUPS = {\"enabled\":false};\n", utf8NoBom);
            return;
        }

        Dictionary<string, Member> members = new Dictionary<string, Member>();
        SampleCount = 0;
        MappedSamples = 0;

        using (FileStream jfs = new FileStream(jtlPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (StreamReader reader = new StreamReader(jfs, Encoding.UTF8, true, 1 << 20))
        {
            List<string> header = ReadRecord(reader);
            if (header == null) return;
            int iTs = header.IndexOf("timeStamp");
            int iElapsed = header.IndexOf("elapsed");
            int iLabel = header.IndexOf("label");
            int iCode = header.IndexOf("responseCode");
            int iSuccess = header.IndexOf("success");
            int iBytes = header.IndexOf("bytes");
            int iSent = header.IndexOf("sentBytes");
            int iMethod = header.IndexOf("REC_METHOD");
            if (iLabel < 0 || iElapsed < 0 || iTs < 0) return;
            int need = Math.Max(Math.Max(iLabel, iElapsed), Math.Max(iTs, Math.Max(iCode, iSuccess)));

            List<string> row;
            while ((row = ReadRecord(reader)) != null)
            {
                if (row.Count <= need) continue;
                string label = row[iLabel];
                if (label.StartsWith(PreparePrefix, StringComparison.Ordinal)) continue;

                int elapsed;
                long ts;
                if (!int.TryParse(row[iElapsed], NumberStyles.Integer, CultureInfo.InvariantCulture, out elapsed)) continue;
                if (!long.TryParse(row[iTs], NumberStyles.Integer, CultureInfo.InvariantCulture, out ts)) continue;

                Member m;
                if (!members.TryGetValue(label, out m))
                {
                    m = new Member();
                    m.Label = label;
                    Mapping map1;
                    if (map.TryGetValue(label, out map1)) { m.Role = map1.Role; m.Order = map1.Order; }
                    else { m.Role = ""; m.Order = int.MaxValue; }
                    members[label] = m;
                }
                if (m.Order != int.MaxValue) MappedSamples++;
                SampleCount++;

                m.Elapsed.Add(elapsed);
                if (ts < m.FirstStart) m.FirstStart = ts;
                if (ts + elapsed > m.LastEnd) m.LastEnd = ts + elapsed;
                bool success = iSuccess >= 0 && string.Equals(row[iSuccess], "true", StringComparison.OrdinalIgnoreCase);
                if (!success) m.Failed++;
                long b;
                if (iBytes >= 0 && iBytes < row.Count && long.TryParse(row[iBytes], NumberStyles.Integer, CultureInfo.InvariantCulture, out b)) m.Bytes += b;
                if (iSent >= 0 && iSent < row.Count && long.TryParse(row[iSent], NumberStyles.Integer, CultureInfo.InvariantCulture, out b)) m.Sent += b;
                string code = iCode >= 0 ? row[iCode] : "";
                long cn;
                m.Codes.TryGetValue(code, out cn);
                m.Codes[code] = cn + 1;
                if (m.Method.Length == 0 && iMethod >= 0 && iMethod < row.Count && row[iMethod].Length > 0 && row[iMethod] != "null")
                    m.Method = row[iMethod];
            }
        }

        // Members -> logical APIs (method + API name). A label with no CSV row
        // (e.g. a skipped row) stands alone as its own API, so no sample is lost.
        Dictionary<string, Group> groups = new Dictionary<string, Group>();
        List<Group> order = new List<Group>();
        foreach (Member m in members.Values)
        {
            Mapping mp;
            string name = m.Label;
            string method = m.Method;
            if (map.TryGetValue(m.Label, out mp)) name = mp.Api;
            int sp = m.Label.IndexOf(' ');
            string labelMethod = sp > 0 ? m.Label.Substring(0, sp) : "";
            if (method.Length == 0) method = labelMethod;
            string key = method + "\u0001" + name;
            Group g;
            if (!groups.TryGetValue(key, out g))
            {
                g = new Group();
                g.Name = name;
                g.Method = method;
                groups[key] = g;
                order.Add(g);
            }
            g.Members.Add(m);
            if (m.Order < g.Order) g.Order = m.Order;
        }
        order.Sort(delegate (Group a, Group b)
        {
            int c = a.Order.CompareTo(b.Order);
            return c != 0 ? c : string.CompareOrdinal(a.Name, b.Name);
        });

        using (StreamWriter w = new StreamWriter(targetPath, false, utf8NoBom))
        {
            w.Write("/* Auto-generated from results.jtl after each report generation. Do not edit manually. */\n");
            w.Write("var REPORT_API_GROUPS = {\"enabled\":true,\"roleCount\":" + RoleCount
                + ",\"apiCount\":" + order.Count
                + ",\"executionCount\":" + SampleCount
                + ",\"groups\":[");
            bool firstGroup = true;
            foreach (Group g in order)
            {
                g.Members.Sort(delegate (Member a, Member b)
                {
                    int c = a.Order.CompareTo(b.Order);
                    return c != 0 ? c : string.CompareOrdinal(a.Label, b.Label);
                });

                // Pool every underlying sample of this API across its roles.
                int total = 0;
                long failed = 0, bytes = 0, sent = 0, first = long.MaxValue, last = long.MinValue;
                Dictionary<string, long> codes = new Dictionary<string, long>();
                List<string> roleList = new List<string>();
                List<string> pathList = new List<string>();
                foreach (Member m in g.Members)
                {
                    total += m.Elapsed.Count;
                    failed += m.Failed; bytes += m.Bytes; sent += m.Sent;
                    if (m.FirstStart < first) first = m.FirstStart;
                    if (m.LastEnd > last) last = m.LastEnd;
                    foreach (KeyValuePair<string, long> kv in m.Codes)
                    {
                        long n; codes.TryGetValue(kv.Key, out n); codes[kv.Key] = n + kv.Value;
                    }
                    string role = m.Role.Length > 0 ? m.Role : "-";
                    if (!roleList.Contains(role)) roleList.Add(role);
                    string p = PathOnly(m.Label);
                    if (!pathList.Contains(p)) pathList.Add(p);
                }
                int[] pooled = new int[total];
                int at = 0;
                foreach (Member m in g.Members) { m.Elapsed.CopyTo(pooled, at); at += m.Elapsed.Count; }
                Array.Sort(pooled);

                if (!firstGroup) w.Write(',');
                firstGroup = false;
                w.Write("{\"name\":"); WriteString(w, g.Name);
                w.Write(",\"method\":"); WriteString(w, g.Method);
                w.Write(",\"roles\":[");
                for (int i = 0; i < roleList.Count; i++) { if (i > 0) w.Write(','); WriteString(w, roleList[i]); }
                w.Write("],\"paths\":[");
                for (int i = 0; i < pathList.Count; i++) { if (i > 0) w.Write(','); WriteString(w, pathList[i]); }
                w.Write("],\"stats\":"); WriteStats(w, Stats(pooled, failed, bytes, sent, first, last));
                w.Write(",\"codes\":"); WriteCodes(w, codes);
                w.Write(",\"members\":[");
                bool firstMember = true;
                foreach (Member m in g.Members)
                {
                    int[] own = m.Elapsed.ToArray();
                    Array.Sort(own);
                    if (!firstMember) w.Write(',');
                    firstMember = false;
                    w.Write("{\"role\":"); WriteString(w, m.Role.Length > 0 ? m.Role : "-");
                    w.Write(",\"label\":"); WriteString(w, m.Label);
                    w.Write(",\"path\":"); WriteString(w, FullPath(m.Label));
                    w.Write(",\"stats\":"); WriteStats(w, Stats(own, m.Failed, m.Bytes, m.Sent, m.FirstStart, m.LastEnd));
                    w.Write(",\"codes\":"); WriteCodes(w, m.Codes);
                    w.Write('}');
                }
                w.Write("]}");
            }
            w.Write("]};\n");
        }
    }
}
'@

$jtlFull = (Resolve-Path -LiteralPath $jtl).ProviderPath
[JtlApiGroups]::Run($jtlFull, $sourceCsv, $target)
if ([JtlApiGroups]::Enabled) {
    Write-Host ("API grouping: {0} roles, {1} samples ({2} matched to a CSV row)" -f [JtlApiGroups]::RoleCount, [JtlApiGroups]::SampleCount, [JtlApiGroups]::MappedSamples)
} else {
    Write-Host 'API grouping: not applicable (the CSV does not name several roles).'
}
