param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$MaxPages = 10
)

# office-to-images.ps1 — 把 PPT/Excel/Word 文档转成每页 PNG
#
# 链路：
#   PPT (.ppt/.pptx)  → PowerPoint COM 直接 Slide.Export 为 PNG
#   Word (.doc/.docx) → Word COM 导出 PDF → Windows.Data.Pdf (WinRT) 渲染 PNG
#   Excel (.xls/.xlsx) → Excel COM 导出 PDF → Windows.Data.Pdf (WinRT) 渲染 PNG
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File office-to-images.ps1 -FilePath x.pptx -OutDir C:\tmp\out

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Log($msg) {
  [Console]::Error.WriteLine("[$([DateTime]::Now.ToString('HH:mm:ss.fff'))] $msg")
}

Log "script start: $FilePath -> $OutDir (max $MaxPages pages)"

# 清理残留的 Office 自动化进程（命令行含 /Automation 或 /Embedding）。
# 自动化进程异常退出后会残留并锁住文档句柄，导致后续 Word/Excel/PPT COM 打开同一文件时挂起。
# 手动打开 Office 文档的进程命令行不带这些标记，不会被误杀。
$automationProcs = Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE' OR Name='EXCEL.EXE' OR Name='POWERPNT.EXE'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match '/Automation|/Embedding' }
foreach ($p in $automationProcs) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
}

$ext = [System.IO.Path]::GetExtension($FilePath).ToLower()
$isPpt = @(".ppt", ".pptx") -contains $ext
$isXls = @(".xls", ".xlsx") -contains $ext
$isDoc = @(".doc", ".docx") -contains $ext

if (-not ($isPpt -or $isXls -or $isDoc)) {
  Write-Error "Unsupported file type: $ext"
  exit 1
}
if (-not (Test-Path $FilePath -PathType Leaf)) {
  Write-Error "File not found: $FilePath"
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ============================================================
# WinRT PDF → PNG（Windows 10/11 内置渲染器，无需额外安装）
# ============================================================
$script:asTaskGeneric = $null

function Initialize-WinRT {
  if ($script:asTaskGeneric) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $script:iAsyncActionType = [Windows.Foundation.IAsyncAction, Windows.Foundation, ContentType = WindowsRuntime]
  [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
}

function Await-Operation($op, $resultType) {
  $m = $script:asTaskGeneric.MakeGenericMethod($resultType)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Await-Action($action) {
  # AsTask 有多个重载，PowerShell 无法自动解析，需反射按 IAsyncAction 参数精确选择
  $m = [System.WindowsRuntimeSystemExtensions].GetMethod("AsTask", [type[]]@($script:iAsyncActionType))
  $task = $m.Invoke($null, @($action))
  $task.Wait(-1) | Out-Null
}

function Convert-PdfToPng($pdfPath, $outDir, $maxPages) {
  Log "Convert-PdfToPng: init WinRT"
  Initialize-WinRT
  Log "Convert-PdfToPng: loading $pdfPath"
  $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfPath)) ([Windows.Storage.StorageFile])
  $doc = Await-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  Log "Convert-PdfToPng: loaded, pages=$($doc.PageCount)"
  $count = [Math]::Min([int]$doc.PageCount, $maxPages)
  $exported = 0
  for ($i = 0; $i -lt $count; $i++) {
    $page = $doc.GetPage($i)
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $opt = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
    $opt.DestinationWidth = 1600
    Await-Action ($page.RenderToStreamAsync($stream, $opt))
    Log "Convert-PdfToPng: page $($i + 1) rendered (size=$($stream.Size))"
    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
    $null = Await-Operation ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
    $bytes = New-Object byte[] ([int]$stream.Size)
    $reader.ReadBytes($bytes)
    $outFile = Join-Path $outDir ("page_{0:D3}.png" -f ($i + 1))
    [System.IO.File]::WriteAllBytes($outFile, $bytes)
    $exported++
    $reader.Dispose(); $page.Dispose(); $stream.Dispose()
  }
  return $exported
}

# ============================================================
# Office COM 转换
# ============================================================
function Export-PptPng($src, $outDir, $maxPages) {
  $ppt = New-Object -ComObject PowerPoint.Application
  try { $ppt.Visible = $false } catch { }
  try {
    $pres = $ppt.Presentations.Open($src, $true, $false, $false)  # ReadOnly, no window
    try {
      $count = [Math]::Min([int]$pres.Slides.Count, $maxPages)
      for ($i = 1; $i -le $count; $i++) {
        $outFile = Join-Path $outDir ("page_{0:D3}.png" -f $i)
        $pres.Slides.Item($i).Export($outFile, "PNG", 1600, 900)
      }
      return $count
    } finally {
      $pres.Close()
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null
    }
  } finally {
    $ppt.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
  }
}

function Export-DocText($src) {
  Log "Export-DocText: creating Word COM"
  $word = New-Object -ComObject Word.Application
  Log "Export-DocText: Word COM created"
  $word.Visible = $false
  $word.DisplayAlerts = 0
  try {
    Log "Export-DocText: opening $src"
    $doc = $word.Documents.Open($src, $false, $true)  # ReadOnly
    $text = $doc.Content.Text
    Log "Export-DocText: read $($text.Length) chars"
    $doc.Close($false)
    return $text
  } finally {
    $word.Quit()
    Log "Export-DocText: Word quit"
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  }
}

function Export-XlsPdf($src, $pdfPath) {
  Log "Export-XlsPdf: creating Excel COM"
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  try {
    Log "Export-XlsPdf: opening $src"
    $wb = $xl.Workbooks.Open($src, $null, $true)  # ReadOnly
    Log "Export-XlsPdf: opened, exporting PDF"
    try { $wb.ExportAsFixedFormat(0, $pdfPath) } finally { $wb.Close($false) }
    Log "Export-XlsPdf: PDF exported to $pdfPath"
  } finally {
    $xl.Quit()
    Log "Export-XlsPdf: Excel quit"
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
  }
}

# ============================================================
# 主流程
# ============================================================
try {
  Log "cleaning stale automation processes"
  if ($isPpt) {
    Log "PPT branch"
    $n = Export-PptPng $FilePath $OutDir $MaxPages
    Write-Output "EXPORTED $n pages"
    exit 0
  }

  $pdfPath = Join-Path $OutDir "_doc.pdf"
  if ($isDoc) {
    # Word PDF export pipeline is unreliable on this machine (ExportAsFixedFormat hangs); read text via COM instead
    $text = Export-DocText $FilePath
    Set-Content -Path (Join-Path $OutDir "text.txt") -Value $text -Encoding UTF8
    Write-Output "EXPORTED text"
    exit 0
  }
  elseif ($isXls) { Export-XlsPdf $FilePath $pdfPath }

  $n = Convert-PdfToPng $pdfPath $OutDir $MaxPages
  Remove-Item $pdfPath -Force -ErrorAction SilentlyContinue
  Write-Output "EXPORTED $n pages"
  exit 0
} catch {
  Write-Error ("CONVERT_FAILED: " + $_.Exception.Message)
  exit 2
}
