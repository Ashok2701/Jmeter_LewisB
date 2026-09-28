<#
    Writes <dashboard>\content\js\report-sample-info.js for the run that has
    just finished: the HTTP method and the actual response status code(s) of
    every sampler label, the status code(s) behind every error type, and one
    row per failed API (method, status code, error, count) for the Errors table.
    It also writes the response body JMeter captured for each API (the
    REC_RESPONSE column) to dashboard\content\responses\r<N>.js, which the
    Statistics table's Response arrow loads on demand.

    The HTML dashboard's own data (statistics / errors summaries) carries
    neither, so this reads them straight from the run's results.jtl, which is
    what JMeter itself recorded. dashboard.js adds them to the Statistics and
    Errors tables; when this file is missing the report still renders, with the
    Method taken from the label and the Status Code shown as "-".

    Called by run_jmeter_test.bat / run_soap_test.bat / run_sql_test.bat AFTER
    the dashboard has been generated, so JMeter's report generation is
    untouched. Paths arrive through environment variables, so nothing needs
    quoting.

    Expected environment variables:
        SAMPLE_INFO_JTL     the run's results.jtl (CSV format, with header row)
        SAMPLE_INFO_FILE    target .js file inside the generated dashboard

    The JTL is streamed through a small compiled CSV reader rather than
    Import-Csv, because a long load test's JTL can run to gigabytes.
#>

$ErrorActionPreference = 'Stop'

$jtl = $env:SAMPLE_INFO_JTL
$target = $env:SAMPLE_INFO_FILE
if ([string]::IsNullOrWhiteSpace($jtl) -or [string]::IsNullOrWhiteSpace($target)) {
    Write-Error 'SAMPLE_INFO_JTL and SAMPLE_INFO_FILE must both be set.'
    exit 1
}
if (-not (Test-Path -LiteralPath $jtl)) {
    Write-Error "Results file not found: $jtl"
    exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

public static class JtlSampleInfo
{
    // Same filter as scripts\report-generator.properties: internal
    // "Prepare - ..." samplers never reach the report, so they are skipped.
    const string PreparePrefix = "Prepare - ";

    public class LabelInfo
    {
        public Dictionary<string, long> Methods = new Dictionary<string, long>();
        public Dictionary<string, long> Codes = new Dictionary<string, long>();
    }

    // One row of the report's Errors table: every failed sample of one API
    // that got the same status code and the same error.
    public class ErrorRow
    {
        public string Label;
        public string Method = "";
        public string Code;
        public string Error;
        public long Count;
    }

    const string NonHttpMessagePrefix = "Non HTTP response message: ";

    // The response body JMeter received for one API and status code, from the
    // REC_RESPONSE column (recorded by RecordResult / RecordSoapResult /
    // ValidateSqlResult - first response per API + status code only).
    public class CapturedResponse
    {
        public string Code;
        public string Body;
    }

    public static bool HasResponseColumn;
    public static Dictionary<string, List<CapturedResponse>> Responses;
    public static List<string> ResponseLabels;

    public static Dictionary<string, LabelInfo> Labels;
    public static Dictionary<string, long> TotalCodes;
    public static Dictionary<string, Dictionary<string, long>> ErrorCodes;
    public static Dictionary<string, ErrorRow> ErrorRows;
    public static long SampleCount;
    public static long ErrorCount;

    static void Count(Dictionary<string, long> map, string key)
    {
        long n;
        map.TryGetValue(key, out n);
        map[key] = n + 1;
    }

    // One CSV record (RFC 4180 quoting, as JMeter writes it); null at EOF.
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

    static bool IsSuccessCode(string code)
    {
        int n;
        return int.TryParse(code, out n) && n >= 200 && n <= 399;
    }

    public static void Scan(string path)
    {
        Labels = new Dictionary<string, LabelInfo>();
        TotalCodes = new Dictionary<string, long>();
        ErrorCodes = new Dictionary<string, Dictionary<string, long>>();
        ErrorRows = new Dictionary<string, ErrorRow>();
        Responses = new Dictionary<string, List<CapturedResponse>>();
        ResponseLabels = new List<string>();
        HasResponseColumn = false;
        SampleCount = 0;
        ErrorCount = 0;

        using (StreamReader reader = new StreamReader(path, Encoding.UTF8, true, 1 << 20))
        {
            List<string> header = ReadRecord(reader);
            if (header == null) return;
            int iLabel = header.IndexOf("label");
            int iCode = header.IndexOf("responseCode");
            int iMsg = header.IndexOf("responseMessage");
            int iSuccess = header.IndexOf("success");
            int iFailure = header.IndexOf("failureMessage");
            int iMethod = header.IndexOf("REC_METHOD");
            int iResp = header.IndexOf("REC_RESPONSE");
            HasResponseColumn = iResp >= 0;
            if (iLabel < 0 || iCode < 0) return;

            List<string> row;
            while ((row = ReadRecord(reader)) != null)
            {
                if (row.Count <= Math.Max(iLabel, iCode)) continue;
                string label = row[iLabel];
                if (label.StartsWith(PreparePrefix, StringComparison.Ordinal)) continue;
                string code = row[iCode];

                LabelInfo info;
                if (!Labels.TryGetValue(label, out info))
                {
                    info = new LabelInfo();
                    Labels[label] = info;
                }
                Count(info.Codes, code);
                Count(TotalCodes, code);
                string method = iMethod >= 0 && iMethod < row.Count ? row[iMethod] : "";
                if (method.Length > 0)
                    Count(info.Methods, method);
                SampleCount++;

                // Only the first response per API + status code is ever
                // written into the column, but a repeat is ignored regardless.
                if (iResp >= 0 && iResp < row.Count && row[iResp].Length > 0)
                {
                    List<CapturedResponse> captured;
                    if (!Responses.TryGetValue(label, out captured))
                    {
                        captured = new List<CapturedResponse>();
                        Responses[label] = captured;
                        ResponseLabels.Add(label);
                    }
                    bool seen = false;
                    foreach (CapturedResponse existing in captured)
                        if (existing.Code == code) { seen = true; break; }
                    if (!seen)
                    {
                        CapturedResponse response = new CapturedResponse();
                        response.Code = code;
                        response.Body = row[iResp];
                        captured.Add(response);
                    }
                }

                bool success = iSuccess >= 0 && iSuccess < row.Count
                    && string.Equals(row[iSuccess], "true", StringComparison.OrdinalIgnoreCase);
                if (success) continue;
                ErrorCount++;

                // The error type exactly as JMeter's ErrorsSummaryConsumer names
                // it (before its HTML escaping, which dashboard.js undoes), so
                // each Errors-table row can be matched to its real status codes.
                string msg = iMsg >= 0 && iMsg < row.Count ? row[iMsg] : "";
                string failure = iFailure >= 0 && iFailure < row.Count ? row[iFailure] : "";
                string key;
                if (IsSuccessCode(code) || (code.Length == 0 && failure.Length > 0))
                    key = failure.Length > 0 ? failure : "Assertion failed";
                else
                    key = msg.Length > 0 ? code + "/" + msg : code;

                Dictionary<string, long> codes;
                if (!ErrorCodes.TryGetValue(key, out codes))
                {
                    codes = new Dictionary<string, long>();
                    ErrorCodes[key] = codes;
                }
                Count(codes, code);

                // The Errors table's per-API row. Error is JMeter's own
                // response message ("Bad Request", "Read timed out"), or the
                // assertion's failure message when the HTTP call itself
                // succeeded but an assertion failed it.
                string error = msg.StartsWith(NonHttpMessagePrefix, StringComparison.Ordinal)
                    ? msg.Substring(NonHttpMessagePrefix.Length)
                    : msg;
                if (failure.Length > 0 && (IsSuccessCode(code) || error.Length == 0))
                    error = failure;

                string rowKey = label + "\u0001" + code + "\u0001" + error;
                ErrorRow errorRow;
                if (!ErrorRows.TryGetValue(rowKey, out errorRow))
                {
                    errorRow = new ErrorRow();
                    errorRow.Label = label;
                    errorRow.Code = code;
                    errorRow.Error = error;
                    ErrorRows[rowKey] = errorRow;
                }
                if (errorRow.Method.Length == 0) errorRow.Method = method;
                errorRow.Count++;
            }
        }
    }

    static void WriteJsonString(TextWriter w, string s)
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
                    // Control characters, the two JS line separators, and "<"
                    // (so a body containing </script> can never end the tag).
                    if (c < 0x20 || (int)c == 0x2028 || (int)c == 0x2029 || (int)c == 0x3c)
                        w.Write("\\u" + ((int)c).ToString("x4"));
                    else
                        w.Write(c);
                    break;
            }
        }
        w.Write('"');
    }

    // One small script per API, loaded by the report only when its arrow is
    // clicked, so the page itself never carries the response bodies:
    //   (window.REPORT_RESPONSES = ...)["r3"] = [{"code":"200","body":"..."}];
    // Returns each API label's file number. Bodies are written exactly as JMeter
    // received them - only JSON-string escaped, never reformatted here.
    public static Dictionary<string, int> WriteResponseFiles(string dir)
    {
        Dictionary<string, int> numbers = new Dictionary<string, int>();
        if (ResponseLabels.Count == 0) return numbers;
        Directory.CreateDirectory(dir);
        UTF8Encoding utf8NoBom = new UTF8Encoding(false);
        int n = 0;
        foreach (string label in ResponseLabels)
        {
            n++;
            numbers[label] = n;
            using (StreamWriter w = new StreamWriter(Path.Combine(dir, "r" + n + ".js"), false, utf8NoBom))
            {
                w.Write("(window.REPORT_RESPONSES = window.REPORT_RESPONSES || {})[\"r" + n + "\"] = [");
                bool first = true;
                foreach (CapturedResponse r in Responses[label])
                {
                    if (!first) w.Write(",");
                    first = false;
                    w.Write("{\"code\":");
                    WriteJsonString(w, r.Code);
                    w.Write(",\"body\":");
                    WriteJsonString(w, r.Body);
                    w.Write("}");
                }
                w.Write("];\n");
            }
        }
        return numbers;
    }
}
'@

[JtlSampleInfo]::Scan((Resolve-Path -LiteralPath $jtl).ProviderPath)

# Codes are listed most frequent first, so a label that mostly returned 200 and
# occasionally 500 reads "200, 500".
function ConvertTo-CodeList($counts) {
    $list = @()
    foreach ($entry in ($counts.GetEnumerator() | Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, @{ Expression = 'Key' })) {
        $list += , @($entry.Key, $entry.Value)
    }
    return , $list
}

# Response bodies go to dashboard\content\responses\r<N>.js (one per API), next
# to the content\js folder the sample-info file lives in.
$responseDir = Join-Path (Split-Path -Parent (Split-Path -Parent $target)) 'responses'
$responseFiles = [JtlSampleInfo]::WriteResponseFiles($responseDir)

$labels = [ordered]@{}
foreach ($entry in [JtlSampleInfo]::Labels.GetEnumerator()) {
    $method = ''
    if ($entry.Value.Methods.Count -gt 0) {
        $method = ($entry.Value.Methods.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 1).Key
    }
    $labels[$entry.Key] = [ordered]@{
        method = $method
        codes  = ConvertTo-CodeList $entry.Value.Codes
    }
    if ($responseFiles.ContainsKey($entry.Key)) {
        $labels[$entry.Key]['resp'] = $responseFiles[$entry.Key]
    }
}

$errors = [ordered]@{}
foreach ($entry in [JtlSampleInfo]::ErrorCodes.GetEnumerator()) {
    $errors[$entry.Key] = ConvertTo-CodeList $entry.Value
}

# Most errors first, as JMeter orders its own Errors table.
$errorRows = @()
foreach ($row in ([JtlSampleInfo]::ErrorRows.Values | Sort-Object -Property @{ Expression = 'Count'; Descending = $true }, Label)) {
    $errorRows += , [ordered]@{
        label  = $row.Label
        method = $row.Method
        code   = $row.Code
        error  = $row.Error
        count  = $row.Count
    }
}

$info = [ordered]@{
    labels      = $labels
    totalCodes  = ConvertTo-CodeList ([JtlSampleInfo]::TotalCodes)
    errors      = $errors
    errorRows   = $errorRows
    sampleCount = [JtlSampleInfo]::SampleCount
    errorCount  = [JtlSampleInfo]::ErrorCount
    # False for a run whose .jtl has no REC_RESPONSE column (made before
    # responses were captured), so the report can say so.
    responsesCaptured = [JtlSampleInfo]::HasResponseColumn
}

# ConvertTo-Json escapes quotes, backslashes and control characters, and "<"
# is escaped too so a label can never close the surrounding <script>.
$json = ($info | ConvertTo-Json -Depth 6 -Compress).Replace('<', '<')

$content = @"
/* Auto-generated from results.jtl after each report generation. Do not edit manually. */
var REPORT_SAMPLE_INFO = $json;
"@

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($target, $content, $utf8NoBom)
