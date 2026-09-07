try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { exit 0 }
} catch {}
$shell = New-Object -ComObject WScript.Shell
$null = $shell.Popup("警廣 PBS Relay 沒有回應！`n`n路況播報員目前可能無法取得警廣資料，請用 TeamViewer 連回電腦啟動。", 60, "路況播報員 - 服務中斷警告", 16)
