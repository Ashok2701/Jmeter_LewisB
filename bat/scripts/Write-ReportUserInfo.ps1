<#
    Writes <dashboard>\content\js\report-user-info.js for the run that has
    just finished: the actual number of runs (and passed/failed) executed by
    EACH user, for the report's "Runs by User" graph.

    There is no per-user counter anywhere in the pipeline - JMeter only ever
    records a per-THREAD threadName (e.g. "API Execution - Thread Group 1-7").
    Which user a thread belongs to is decided by scripts\AssignLoginUser.groovy,
    which assigns the thread at position T (1-based) the login at index
    (T - 1) % numUsers, i.e. round-robin. This script re-derives the same
    mapping from results.jtl - the run's own recorded samples - so a user's
    run count is always the real, counted number of requests its threads
    actually made, never Threads x Loops x Users divided evenly.

    Query Testing (and any run started without NUM_USERS) has no login and so
    no per-user breakdown: this still writes the file, with an empty array,
    so the report's JS does not need to special-case a missing file.

    Called by run_jmeter_test.bat / run_soap_test.bat AFTER the dashboard has
    been generated, the same way Write-ReportSampleInfo.ps1 is. Paths and
    NUM_USERS arrive through environment variables, so nothing needs quoting.

    Expected environment variables:
        USER_INFO_JTL        the run's results.jtl (CSV format, with header row)
        USER_INFO_FILE       target .js file inside the generated dashboard
        USER_INFO_NUM_USERS  Number of Users for this run (REST/SOAP only;
                              blank/0 for Query Testing or a hand-run .bat)

    The JTL is streamed through a small compiled CSV reader rather than
    Import-Csv, because a long load test's JTL can run to gigabytes - the same
    approach Write-ReportSampleInfo.ps1 uses.
#>

$ErrorActionPreference = 'Stop'

$jtl = $env:USER_INFO_JTL
$target = $env:USER_INFO_FILE
if ([string]::IsNullOrWhiteSpace($jtl) -or [string]::IsNullOrWhiteSpace($target)) {
    Write-Error 'USER_INFO_JTL and USER_INFO_FILE must both be set.'
    exit 1
}
if (-not (Test-Path -LiteralPath $jtl)) {
    Write-Error "Results file not found: $jtl"
    exit 1
}

$numUsers = 0
[void][int]::TryParse($env:USER_INFO_NUM_USERS, [ref]$numUsers)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public static class JtlUserInfo
{
    // Same filter as Write-ReportSampleInfo.ps1 / report-generator.properties:
    // internal "Prepare - ..." samplers never reach the report.
    const string PreparePrefix = "Prepare - ";

    // Matches the trailing "<group>-<thread>" JMeter appends to every thread
    // name, e.g. "API Execution - Thread Group 1-7" -> thread 7.
    static readonly Regex ThreadNumber = new Regex(@"-(\d+)\s*$", RegexOptions.Compiled);

    public class UserStats
    {
        public long Runs;
        public long Passed;
        public long Failed;
    }

    public static SortedDictionary<int, UserStats> ByUser;

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

    public static void Scan(string path, int numUsers)
    {
        ByUser = new SortedDictionary<int, UserStats>();
        if (numUsers <= 0) return;

        using (StreamReader reader = new StreamReader(path, Encoding.UTF8, true, 1 << 20))
        {
            List<string> header = ReadRecord(reader);
            if (header == null) return;
            int iLabel = header.IndexOf("label");
            int iThread = header.IndexOf("threadName");
            int iSuccess = header.IndexOf("success");
            if (iLabel < 0 || iThread < 0) return;

            List<string> row;
            while ((row = ReadRecord(reader)) != null)
            {
                if (row.Count <= Math.Max(iLabel, iThread)) continue;
                string label = row[iLabel];
                if (label.Length == 0 || label == "Total" || label.StartsWith(PreparePrefix, StringComparison.Ordinal))
                    continue;

                Match m = ThreadNumber.Match(row[iThread]);
                if (!m.Success) continue;
                int threadNum = int.Parse(m.Groups[1].Value);
                if (threadNum < 1) continue;

                // Same assignment AssignLoginUser.groovy makes: thread T (1-based)
                // -> login index (T - 1) % numUsers -> "User" (index + 1).
                int userNumber = ((threadNum - 1) % numUsers) + 1;

                UserStats stats;
                if (!ByUser.TryGetValue(userNumber, out stats))
                {
                    stats = new UserStats();
                    ByUser[userNumber] = stats;
                }
                stats.Runs++;

                bool success = iSuccess >= 0 && iSuccess < row.Count
                    && string.Equals(row[iSuccess], "true", StringComparison.OrdinalIgnoreCase);
                if (success) stats.Passed++;
                else stats.Failed++;
            }
        }
    }
}
'@

[JtlUserInfo]::Scan((Resolve-Path -LiteralPath $jtl).ProviderPath, $numUsers)

$users = @()
foreach ($entry in [JtlUserInfo]::ByUser.GetEnumerator()) {
    $users += , [ordered]@{
        user   = "User $($entry.Key)"
        runs   = $entry.Value.Runs
        passed = $entry.Value.Passed
        failed = $entry.Value.Failed
    }
}

# -InputObject (never piped) is what keeps this a JSON array for 0, 1 and
# many users alike on Windows PowerShell 5.1, which has no -AsArray: piping
# an array to ConvertTo-Json unrolls it one element at a time (fine for 2+,
# but a single element collapses to a bare object instead of a 1-item array).
$json = (ConvertTo-Json -InputObject $users -Depth 4 -Compress).Replace('<', '<')

$content = @"
/* Auto-generated from results.jtl after each report generation. Do not edit manually. */
var REPORT_USER_INFO = $json;
"@

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($target, $content, $utf8NoBom)
