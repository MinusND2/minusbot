# PowerShell script to export YouTube (and Google) cookies from Chrome/Edge and write them to the bot's expected JSON file
# ------------------------------------------------------------
# Requirements:
#   - PowerShell 5+ (built‑in on Windows)
#   - Chrome or Edge installed (cookies stored in the user's local app data)
#   - .NET Framework (used for DPAPI decryption)
#   - No additional npm packages needed – everything is pure PowerShell.
# ------------------------------------------------------------
# How it works:
#   1. Copies the Chrome/Edge SQLite cookie database to a temporary location (so the browser can keep it locked).
#   2. Opens the SQLite file with System.Data.SQLite (built‑in .NET provider).
#   3. Queries all cookies whose host_key ends with .youtube.com or .google.com.
#   4. Decrypts the encrypted_value column using Windows DPAPI (CurrentUser scope).
#   5. Converts the Chrome timestamp (microseconds since 1601‑01‑01) to a Unix timestamp (seconds since 1970‑01‑01).
#   6. Writes a JSON array containing the fields that the backend expects.
#   7. Saves the file to d:\bingo\backend\youtube_sessions\youtube_cookie_default.json
# ------------------------------------------------------------
# Usage:
#   1. Open a PowerShell console with normal user rights (no admin required).
#   2. Execute the script:   .\export_youtube_cookies.ps1
#   3. The script will output the path of the generated JSON file.
#   4. Ensure the bot service (PM2) is (re)started so it picks up the new cookie file.
# ------------------------------------------------------------
# NOTE: If you use Microsoft Edge instead of Chrome, change the $chromePath variable to the Edge path.
# ------------------------------------------------------------

# ---- Configuration -------------------------------------------------
# Path to the Chrome cookie database (Default profile). Adjust if you use a different profile.
$chromePath = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cookies"
# If you prefer Edge replace the line above with:
# $chromePath = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cookies"

# Target directory for the exported cookie JSON (must match backend expectation)
$targetDir = "d:\bingo\backend\youtube_sessions"
# Name of the file – the backend looks for youtube_cookie_<account>.json. We use "default" here.
$outFile = Join-Path $targetDir "youtube_cookie_default.json"
# ------------------------------------------------------------

# ---- Helper: Decrypt encrypted_value using DPAPI ----------------
Add-Type -AssemblyName System.Security
function Decrypt-Value([byte[]]$encrypted) {
    if ($encrypted.Length -le 3) { return "" }
    # Chrome stores encrypted cookies as: 'v10' + DPAPI‑encrypted bytes
    $payload = $encrypted[3..($encrypted.Length-1)]
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($payload, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [System.Text.Encoding]::UTF8.GetString($decrypted)
}

# ---- Prepare temporary copy of the cookie DB ----------------------
$tempPath = "$env:TEMP\CookiesTemp"
if (Test-Path $tempPath) { Remove-Item $tempPath -Force }
Copy-Item -Path $chromePath -Destination $tempPath -Force

# ---- Load SQLite assembly (built‑in) ------------------------------
# .NET provides System.Data.SQLite only if the assembly is present. Most Windows systems ship it.
# If not, you can install the SQLite Core via PowerShell: Install-Package System.Data.SQLite.Core
Add-Type -AssemblyName System.Data.SQLite

# ---- Open DB and query required cookies ---------------------------
$connStr = "Data Source=$tempPath;Version=3;Read Only=True;"
$connection = New-Object System.Data.SQLite.SQLiteConnection($connStr)
$connection.Open()
$command = $connection.CreateCommand()
$command.CommandText = "SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, same_site FROM cookies WHERE host_key LIKE '%.youtube.com' OR host_key LIKE '%.google.com'"
$reader = $command.ExecuteReader()

$cookies = @()
while ($reader.Read()) {
    $host = $reader.GetString(0)
    $name = $reader.GetString(1)
    $enc  = $reader.GetValue(2)   # byte[]
    $path = $reader.GetString(3)
    $expiresUtc = $reader.GetInt64(4)
    $secure = [bool]$reader.GetInt32(5)
    $httpOnly = [bool]$reader.GetInt32(6)
    $sameSiteInt = $reader.GetInt32(7)
    $value = Decrypt-Value $enc

    # Chrome stores timestamps in microseconds since 1601‑01‑01.
    # Convert to Unix seconds.
    $unixTs = [math]::Floor(($expiresUtc / 1000000) - 11644473600)
    $sameSite = switch ($sameSiteInt) {
        0 { $null }
        1 { "lax" }
        2 { "strict" }
        default { $null }
    }

    $cookieObj = [PSCustomObject]@{
        domain = $host
        name = $name
        value = $value
        path = $path
        expirationDate = $unixTs
        httpOnly = $httpOnly
        secure = $secure
        sameSite = $sameSite
    }
    $cookies += $cookieObj
}
$reader.Close()
$connection.Close()
Remove-Item $tempPath -Force

# ---- Ensure target directory exists --------------------------------
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir | Out-Null
}

# ---- Write JSON file ------------------------------------------------
$cookies | ConvertTo-Json -Depth 5 | Out-File -FilePath $outFile -Encoding UTF8
Write-Host "Exported $($cookies.Count) YouTube/Google cookies to $outFile"

# End of script
