# keep-awake.ps1
#
# Prevents Windows from sleeping or starting the screensaver during long
# TCC pipeline phases (typically `media:embed` or `media:classify`, which
# can run for several hours).
#
# Usage: open a separate PowerShell terminal and run
#   powershell -ExecutionPolicy Bypass -File tools/keep-awake.ps1
# then Ctrl+C to stop.
#
# How it works: sends an F15 keystroke (a visual no-op) every 60 seconds
# so Windows thinks the user is still active.

Add-Type -AssemblyName System.Windows.Forms
Write-Host "Keep-awake running (F15 every 60s). Ctrl+C to stop."
while ($true) {
    [System.Windows.Forms.SendKeys]::SendWait("{F15}")
    Start-Sleep -Seconds 60
}
