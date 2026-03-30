
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0

powercfg /change standby-timeout-ac 60
powercfg /change monitor-timeout-ac 30



La solution la plus fiable c'est le script F15 que je t'ai donné.
Lance-le dans un terminal PowerShell séparé avant ton classify :

# keep-awake.ps1 — lance ça dans un terminal à part
Add-Type -AssemblyName System.Windows.Forms
Write-Host "Keep-awake actif (F15 toutes les 60s). Ctrl+C pour stopper."
while ($true) {
[System.Windows.Forms.SendKeys]::SendWait("{F15}")
Start-Sleep -Seconds 60
}


En pratique c'est très peu probable qu'ils s'y intéressent, mais c'est bon à savoir.
Une alternative encore plus discrète serait de bouger le curseur de 1 pixel :

Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }' -Name U -Namespace W
while ($true) {
$p = New-Object W.U+POINT
[W.U]::GetCursorPos([ref]$p) | Out-Null
[W.U]::SetCursorPos($p.X + 1, $p.Y) | Out-Null
Start-Sleep -Milliseconds 50
[W.U]::SetCursorPos($p.X, $p.Y) | Out-Null
Start-Sleep -Seconds 60
}