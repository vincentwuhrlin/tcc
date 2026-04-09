
# Pour eviter l'economiseur d'écran lor d'un classify
# keep-awake.ps1 — lance ça dans un terminal à part
Add-Type -AssemblyName System.Windows.Forms
Write-Host "Keep-awake actif (F15 toutes les 60s). Ctrl+C pour stopper."
while ($true) {
[System.Windows.Forms.SendKeys]::SendWait("{F15}")
Start-Sleep -Seconds 60
}


