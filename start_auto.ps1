# Server starten (minimiert)
Write-Host "Starte Server..." -ForegroundColor Yellow
Start-Process "node" -ArgumentList "server.js" -WindowStyle Minimized

# SSH Tunnel starten
Write-Host "Verbinde mit dem Internet..." -ForegroundColor Yellow
Write-Host "Bitte warten... (Gleich erscheint der Link)" -ForegroundColor Gray

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "ssh"
$psi.Arguments = "-o StrictHostKeyChecking=no -R 80:localhost:3000 nokey@localhost.run"
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi
$process.Start() | Out-Null

# Output lesen und nach Link suchen
while (-not $process.StandardOutput.EndOfStream) {
    $line = $process.StandardOutput.ReadLine()
    
    # Prüfen ob Link in der Zeile ist
    if ($line -match "(https://[a-zA-Z0-9]+\.lhr\.life)") {
        $url = $matches[1]
        
        # Bildschirm aufräumen und Ergebnis anzeigen
        Clear-Host
        Write-Host "===================================================" -ForegroundColor Green
        Write-Host "              BINGO IST ONLINE!" -ForegroundColor Green
        Write-Host "===================================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "Dein Haupt-Link:" -ForegroundColor White
        Write-Host "$url" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Scoreboard (fuer OBS):" -ForegroundColor White
        Write-Host "$url/scoreboard.html" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Admin Panel (zum Steuern):" -ForegroundColor White
        Write-Host "$url/admin" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "===================================================" -ForegroundColor Green
        Write-Host "Lass dieses Fenster offen, solange du streamst!" -ForegroundColor Red
    }
}
