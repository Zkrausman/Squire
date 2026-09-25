param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$SnapshotPath
)

$ErrorActionPreference = 'Stop'
$created = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\SquireActiveTicketsWindow', [ref]$created)
if (-not $created) { $mutex.Dispose(); exit 0 }
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SquireConsole {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
    $consoleWindow = [SquireConsole]::GetConsoleWindow()
    if ($consoleWindow -ne [IntPtr]::Zero) { [void][SquireConsole]::ShowWindow($consoleWindow, 0) }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $form = [System.Windows.Forms.Form]::new()
    $form.Text = 'Squire - Active tickets'
    $form.StartPosition = 'CenterScreen'
    $form.MinimumSize = [System.Drawing.Size]::new(500, 400)
    $form.Size = [System.Drawing.Size]::new(640, 440)
    $form.Font = [System.Drawing.Font]::new('Segoe UI', 10)
    $form.AutoScaleMode = 'Dpi'

    $heading = [System.Windows.Forms.Label]::new()
    $heading.Text = 'Squire'
    $heading.Font = [System.Drawing.Font]::new('Segoe UI Semibold', 15)
    $heading.AutoSize = $true
    $heading.Location = [System.Drawing.Point]::new(12, 12)
    $form.Controls.Add($heading)

    $list = [System.Windows.Forms.ListView]::new()
    $list.View = 'Details'
    $list.FullRowSelect = $true
    $list.HeaderStyle = 'Nonclickable'
    $list.MultiSelect = $false
    $list.Location = [System.Drawing.Point]::new(12, 52)
    $list.Anchor = 'Top,Left,Right'
    $list.Size = [System.Drawing.Size]::new(600, 150)
    [void]$list.Columns.Add('Ticket', 115)
    [void]$list.Columns.Add('Status', 105)
    [void]$list.Columns.Add('Name', 365)
    $form.Controls.Add($list)

    $empty = [System.Windows.Forms.Label]::new()
    $empty.Text = 'No active Squire tickets.'
    $empty.AutoSize = $true
    $empty.Location = [System.Drawing.Point]::new(22, 90)
    $form.Controls.Add($empty)
    $empty.BringToFront()

    $hint = [System.Windows.Forms.Label]::new()
    $hint.Text = 'Click a ticket to view its latest Luna report'
    $hint.AutoSize = $true
    $hint.Location = [System.Drawing.Point]::new(12, 212)
    $form.Controls.Add($hint)

    $detail = [System.Windows.Forms.TextBox]::new()
    $detail.Multiline = $true
    $detail.ReadOnly = $true
    $detail.WordWrap = $true
    $detail.ScrollBars = 'Vertical'
    $detail.TabStop = $false
    $detail.Location = [System.Drawing.Point]::new(12, 238)
    $detail.Anchor = 'Top,Bottom,Left,Right'
    $detail.Size = [System.Drawing.Size]::new(600, 118)
    $form.Controls.Add($detail)

    $disclaimer = [System.Windows.Forms.Label]::new()
    $disclaimer.Text = 'Observation only - not verification or approval.'
    $disclaimer.AutoSize = $true
    $disclaimer.Anchor = 'Bottom,Left'
    $disclaimer.Location = [System.Drawing.Point]::new(12, 362)
    $form.Controls.Add($disclaimer)

    $script:rowsByRun = @{}
    $script:selectedRunId = $null
    $script:refreshing = $false
    $renderDetails = {
        $row = if ($script:selectedRunId) { $script:rowsByRun[$script:selectedRunId] } else { $null }
        if (-not $row) { $detail.Text = 'Select a ticket to see its latest status report.'; return }
        if (-not $row.report) { $detail.Text = 'No Luna report yet for this phase. The phase above is live runner status.'; return }
        $report = $row.report
        $when = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$report.finishedAtMs).ToLocalTime().ToString('g')
        $lines = @("Luna report #$($report.number) - $($report.status) ($($report.phase), $when)",
            "Current action: $($report.currentAction)", "Confidence: $($report.confidence)")
        foreach ($field in @('evidence', 'risks', 'stalls')) {
            $values = @($report.$field | Where-Object { $null -ne $_ })
            if ($values.Count -gt 0) {
                $lines += "$($field.Substring(0,1).ToUpper() + $field.Substring(1)):"
                foreach ($value in $values) { $lines += "  - $value" }
            }
        }
        $detail.Text = $lines -join [Environment]::NewLine
    }
    $list.Add_SelectedIndexChanged({
        if ($script:refreshing) { return }
        $script:selectedRunId = if ($list.SelectedItems.Count) { [string]$list.SelectedItems[0].Tag } else { $null }
        & $renderDetails
    })
    & $renderDetails

    $refresh = {
        try {
            $raw = & $NodePath $SnapshotPath --snapshot $Root 2>$null
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($raw -join ''))) { throw 'Snapshot unavailable' }
            $parsed = ($raw -join '') | ConvertFrom-Json
            $rows = if ($null -eq $parsed) { @() } else { @($parsed) }
            $list.BeginUpdate()
            $script:refreshing = $true
            try {
                $list.Items.Clear()
                $script:rowsByRun = @{}
                foreach ($row in $rows) {
                    $item = [System.Windows.Forms.ListViewItem]::new([string]$row.ticketId)
                    $status = switch ([string]$row.phase) {
                        'starting' { 'Starting' }
                        'preflight' { 'Preflight' }
                        'clone' { 'Preparing' }
                        'plan' { 'Planning' }
                        'implement' { 'Implementing' }
                        'artifact' { 'Finishing' }
                        default { 'Working' }
                    }
                    [void]$item.SubItems.Add($status)
                    [void]$item.SubItems.Add([string]$row.ticketName)
                    $item.Tag = [string]$row.runId
                    $script:rowsByRun[$item.Tag] = $row
                    [void]$list.Items.Add($item)
                    if ($item.Tag -eq $script:selectedRunId) { $item.Selected = $true }
                }
                if ($script:selectedRunId -and -not $script:rowsByRun.ContainsKey($script:selectedRunId)) {
                    $script:selectedRunId = $null
                }
            } finally { $script:refreshing = $false; $list.EndUpdate() }
            $empty.Text = 'No active Squire tickets.'
            $empty.Visible = $rows.Count -eq 0
        } catch {
            $script:rowsByRun = @{}
            $script:selectedRunId = $null
            $list.Items.Clear()
            $empty.Text = 'Squire status unavailable.'
            $empty.Visible = $true
        }
        & $renderDetails
        $empty.BringToFront()
    }
    $timer = [System.Windows.Forms.Timer]::new()
    $timer.Interval = 2500
    $timer.Add_Tick($refresh)
    & $refresh
    $timer.Start()
    try { [System.Windows.Forms.Application]::Run($form) }
    finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
